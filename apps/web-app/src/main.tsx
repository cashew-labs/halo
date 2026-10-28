import { mountHaloApp } from "@get-halo/web/mountHaloApp";
import { WebHost } from "./WebHost.js";

mountHaloApp(document.getElementById("root")!, new WebHost());

if ("serviceWorker" in navigator)
  window.addEventListener("load", () => {
    void navigator.serviceWorker
      .register("/service-worker.js", {
        type: "module",
        updateViaCache: "none",
      })
      .catch(console.warn);
  });
