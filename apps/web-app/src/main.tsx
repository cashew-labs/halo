import { mountHaloApp } from "@get-halo/web/mountHaloApp";
import { webHost } from "./WebHost.js";

mountHaloApp(document.getElementById("root")!, webHost);
