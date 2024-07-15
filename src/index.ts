type Writable = {
  write(html: string): void;
  abort(err: Error): void;
  close(): Promise<void>;
};

const createHTMLDocument = () => document.implementation.createHTMLDocument("");
let createDocument = (
  target: ParentNode,
  nextSibling: ChildNode | null
): Document => {
  const testDoc = createHTMLDocument();
  testDoc.write("<script>");
  /**
   * Safari and potentially other browsers strip script tags from detached documents.
   * If that's the case we'll fallback to an iframe implementation.
   */
  createDocument = testDoc.scripts.length
    ? createHTMLDocument
    : (target, nextSibling) => {
        const frame = document.createElement("iframe");
        frame.src = "";
        frame.style.display = "none";
        target.insertBefore(frame, nextSibling);
        const doc = frame.contentDocument!;
        const { close } = doc;
        doc.close = () => {
          target.removeChild(frame);
          close.call(doc);
        };

        return doc;
      };

  return createDocument(target, nextSibling);
};

interface writableDOMType {
  new (
    target: ParentNode,
    extraOptions?:
      | {
          previousSibling?: ChildNode | null;
          scriptLoadingDocument?: Document;
        }
      | ChildNode
      | null
  ): WritableStream<string>;
  (
    target: ParentNode,
    extraOptions?:
      | {
          previousSibling?: ChildNode | null;
          scriptLoadingDocument?: Document;
        }
      | ChildNode
      | null
  ): Writable;
}

const writableDOM: writableDOMType = function writableDOM(
  this: unknown,
  target: ParentNode,
  extraOptions?:
    | {
        previousSibling?: ChildNode | null;
        scriptLoadingDocument?: Document;
      }
    | ChildNode
    | null
): Writable | WritableStream<string> {
  const { previousSibling, scriptLoadingDocument } =
    extraOptions instanceof Node || extraOptions === null
      ? { previousSibling: extraOptions, scriptLoadingDocument: document }
      : {
          previousSibling: null,
          scriptLoadingDocument: document,
          ...extraOptions,
        };

  if (this instanceof writableDOM) {
    return new WritableStream(writableDOM(target, extraOptions));
  }

  const nextSibling = previousSibling ? previousSibling.nextSibling : null;
  const doc = createDocument(target, nextSibling);
  doc.write("<!DOCTYPE html><body><template>");
  const root = (doc.body.firstChild as HTMLTemplateElement).content;
  const walker = doc.createTreeWalker(root);
  const targetNodes = new WeakMap<Node, Node>([[root, target]]);
  let pendingText: Text | null = null;
  let scanNode: Node | null = null;
  let resolve: void | (() => void);
  let isBlocked = false;
  let inlineHostNode: Node | null = null;

  return {
    write(chunk: string) {
      doc.write(chunk);

      if (pendingText && !inlineHostNode) {
        // When we left on text, it's possible more text was written to the same node.
        // here we copy in the final text content from the detached dom to the live dom.
        (targetNodes.get(pendingText) as Text).data = pendingText.data;
      }

      walk();
    },
    abort() {
      if (isBlocked) {
        (targetNodes.get(walker.currentNode) as Element).remove();
      }
    },
    close() {
      const promise = isBlocked
        ? new Promise<void>((_) => (resolve = _))
        : Promise.resolve();

      return promise.then(() => {
        appendInlineTextIfNeeded(pendingText, inlineHostNode);

        if (inlineHostNode instanceof HTMLScriptElement) {
          evalScript(inlineHostNode);
        }
      });
    },
  };

  function walk(): void {
    let node: Node | null;
    if (isBlocked) {
      // If we are blocked, we walk ahead and preload
      // any assets we can ahead of the last checked node.
      const blockedNode = walker.currentNode;
      if (scanNode) walker.currentNode = scanNode;

      while ((node = walker.nextNode())) {
        const link = getPreloadLink((scanNode = node), target.ownerDocument!);
        if (link) {
          link.onload = link.onerror = () => link.remove();
          // TODO: this code appends links before the target container which could have unexpected consequences
          // wouldn't it be better to use scriptLoadingDocument or some other container instead?
          target.insertBefore(link, nextSibling);
        }
      }

      walker.currentNode = blockedNode;
    } else {
      while ((node = walker.nextNode())) {
        const clone = document.importNode(node, false);
        const previousPendingText = pendingText;
        if (node.nodeType === Node.TEXT_NODE) {
          pendingText = node as Text;
        } else {
          pendingText = null;

          if (isBlocking(clone)) {
            isBlocked = true;
            clone.onload = clone.onerror = () => {
              isBlocked = false;
              // Continue the normal content injecting walk.
              if (clone.parentNode) walk();
            };
          }
        }

        const parentNode = targetNodes.get(node.parentNode!)!;
        // TODO: handle cleaning up scriptClone on abort
        targetNodes.set(node, clone);

        if (isInlineHost(parentNode!)) {
          inlineHostNode = parentNode;
        } else {
          appendInlineTextIfNeeded(previousPendingText, inlineHostNode);
          if (inlineHostNode && inlineHostNode instanceof HTMLScriptElement) {
            evalScript(inlineHostNode);
          }
          inlineHostNode = null;

          let originalScriptType = undefined;
          if (clone instanceof HTMLScriptElement) {
            originalScriptType = clone.getAttribute("type");
            clone.type = "reframed-inert-script";
          }

          if (parentNode === target) {
            target.insertBefore(clone, nextSibling);
          } else {
            parentNode.appendChild(clone);
          }
          if (clone instanceof HTMLScriptElement) {
            //restore script.type so the DOM doesn't look different from the original
            if (originalScriptType === null) {
              clone.removeAttribute("type");
            } else {
              clone.type = originalScriptType!;
            }

            // eval unless it's an inline script - for those we still need to append script content
            if (!isInlineHost(clone)) {
              evalScript(clone);
            }
          }
        }

        // Start walking for preloads.
        if (isBlocked) return walk();
      }

      // Some blocking content could have prevented load.
      if (resolve) resolve();
    }
  }

  // TODO: could this whole fn be moved to reframed, and passed in instead of scriptLoadingDocument?
  function evalScript(scriptElement: HTMLScriptElement): void {
    const clone = scriptLoadingDocument.importNode(
      scriptElement,
      true
    ) as HTMLScriptElement;

    let origCurrentScriptDesc: PropertyDescriptor | undefined;
    let documentPrototype: Document | undefined;

    // document.currentScript is not set for type=module
    if (
      scriptElement.type != "module" &&
      //TODO: support external scripts as well, somehow - tricky because requires async cleanup
      !scriptElement.src
    ) {
      documentPrototype = Object.getPrototypeOf(
        Object.getPrototypeOf(scriptLoadingDocument)
      );
      origCurrentScriptDesc = Object.getOwnPropertyDescriptor(
        documentPrototype,
        "currentScript"
      );
      assert(
        origCurrentScriptDesc !== undefined,
        "document.currentScript is undefined!"
      );

      Object.defineProperty(documentPrototype, "currentScript", {
        get: () => scriptElement,
        set: undefined,
        enumerable: true,
        configurable: true,
      });
    }

    //@ts-expect-error this is a bad hack, all of this should be moved to reframed
    scriptLoadingDocument.unreframedBody.appendChild(clone);

    // restore document.currentScript
    if (origCurrentScriptDesc) {
      const restoreCurrentScript = () => {
        Object.defineProperty(
          documentPrototype,
          "currentScript",
          origCurrentScriptDesc
        );
      };
      clone.addEventListener("load", restoreCurrentScript);
      clone.addEventListener("error", restoreCurrentScript);
    }
  }
} as writableDOMType;

function isBlocking(node: any): node is HTMLElement {
  return (
    node.nodeType === Node.ELEMENT_NODE &&
    ((node.tagName === "SCRIPT" &&
      node.src &&
      !(
        node.noModule ||
        node.type === "module" ||
        node.hasAttribute("async") ||
        node.hasAttribute("defer")
      )) ||
      (node.tagName === "LINK" &&
        node.rel === "stylesheet" &&
        (!node.media || matchMedia(node.media).matches)))
  );
}

function getPreloadLink(node: any, document: Document) {
  let link: HTMLLinkElement | undefined;
  if (node.nodeType === Node.ELEMENT_NODE) {
    switch (node.tagName) {
      case "SCRIPT":
        if (node.src && !node.noModule) {
          link = document.createElement("link");
          link.href = node.src;
          if (node.getAttribute("type") === "module") {
            link.rel = "modulepreload";
          } else {
            link.rel = "preload";
            link.as = "script";
          }
        }
        break;
      case "LINK":
        if (
          node.rel === "stylesheet" &&
          (!node.media || matchMedia(node.media).matches)
        ) {
          link = document.createElement("link");
          link.href = node.href;
          link.rel = "preload";
          link.as = "style";
        }
        break;
      case "IMG":
        link = document.createElement("link");
        link.rel = "preload";
        link.as = "image";
        if (node.srcset) {
          link.imageSrcset = node.srcset;
          link.imageSizes = node.sizes;
        } else {
          link.href = node.src;
        }
        break;
    }

    if (link) {
      if (node.integrity) {
        link.integrity = node.integrity;
      }

      if (node.crossOrigin) {
        link.crossOrigin = node.crossOrigin;
      }
    }
  }

  return link;
}

function appendInlineTextIfNeeded(
  pendingText: Text | null,
  inlineTextHostNode: Node | null
) {
  if (pendingText && inlineTextHostNode) {
    if (inlineTextHostNode instanceof HTMLScriptElement) {
      const originalScriptType = inlineTextHostNode.getAttribute("type");
      inlineTextHostNode.type = "reframed-inert-script";

      inlineTextHostNode.appendChild(pendingText);

      //restore original script.type
      if (originalScriptType === null) {
        inlineTextHostNode.removeAttribute("type");
      } else {
        inlineTextHostNode.type = originalScriptType!;
      }
    } else {
      inlineTextHostNode.appendChild(pendingText);
    }
  }
}

function isInlineHost(node: Node) {
  const { tagName } = node as Element;
  return (
    (tagName === "SCRIPT" && !(node as HTMLScriptElement).src) ||
    tagName === "STYLE"
  );
}

/**
 * A generic assertion function.
 *
 * Typescript doesn't seem to consider `console.assert` to be an assertion function so we have this wrapper
 * https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-7.html#assertion-functions
 */
function assert(value: boolean, message: string): asserts value {
  console.assert(value, message);
}

export { writableDOM as default };
