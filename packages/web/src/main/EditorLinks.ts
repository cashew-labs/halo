import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";

export const EditorLinks = Extension.create({
  name: "editorLinks",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            click(_view, event) {
              const link =
                event.target instanceof Element
                  ? event.target.closest("a[href]")
                  : undefined;
              if (!(link instanceof HTMLAnchorElement)) return false;
              if (!(event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                event.stopPropagation();
                return true;
              }
              // Halo's host and pane capture handlers own opening links.
              return false;
            },
          },
        },
        view(view) {
          const window = view.dom.ownerDocument.defaultView!;
          const update = (event: KeyboardEvent | PointerEvent) =>
            view.dom.classList.toggle(
              "halo-link-modifier",
              event.metaKey || event.ctrlKey,
            );
          const clear = () => view.dom.classList.remove("halo-link-modifier");
          window.addEventListener("keydown", update);
          window.addEventListener("keyup", update);
          window.addEventListener("blur", clear);
          view.dom.addEventListener("pointermove", update);
          return {
            destroy() {
              window.removeEventListener("keydown", update);
              window.removeEventListener("keyup", update);
              window.removeEventListener("blur", clear);
              view.dom.removeEventListener("pointermove", update);
              clear();
            },
          };
        },
      }),
    ];
  },
});
