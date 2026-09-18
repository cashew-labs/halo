import { mountHaloApp } from "@get-halo/web/mountHaloApp";
import { WebHost } from "./WebHost.js";

mountHaloApp(document.getElementById("root")!, new WebHost());
