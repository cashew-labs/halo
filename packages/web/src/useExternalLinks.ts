import { useEffect } from "react";
import type { HostApi } from "./HostApi.js";

/** Capture before editable Markdown and client-side routers consume the click. */
export function useExternalLinks(host: HostApi) {
  useEffect(() => {
    function openLink(event: MouseEvent) {
      if (event.type === "click" ? event.button !== 0 : event.button !== 1)
        return;
      const link =
        event.target instanceof Element
          ? event.target.closest("a[href]")
          : undefined;
      if (!(link instanceof HTMLAnchorElement)) return;
      const href = link.getAttribute("href");
      // Relative links belong to Halo's router or the current document.
      if (href === null || !/^(https?:)?\/\//i.test(href)) return;
      if (link.protocol !== "https:" && link.protocol !== "http:") return;
      if (
        link.isContentEditable &&
        !event.metaKey &&
        !event.ctrlKey &&
        event.button !== 1
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (host.openExternalUrl === undefined) {
        window.open(link.href, "_blank", "noopener,noreferrer");
        return;
      }
      // Hosts return errors as values at the operating-system boundary.
      void host
        .openExternalUrl(link.href)
        .then((result) => {
          if (result instanceof Error)
            console.warn("Could not open link:", result);
        })
        .catch(console.error);
    }
    document.addEventListener("click", openLink, true);
    document.addEventListener("auxclick", openLink, true);
    return () => {
      document.removeEventListener("click", openLink, true);
      document.removeEventListener("auxclick", openLink, true);
    };
  }, [host]);
}
