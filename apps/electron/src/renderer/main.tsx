import { mountHaloApp } from "@get-halo/web/mountHaloApp";
import { ElectronHost } from "./ElectronHost.js";

mountHaloApp(document.getElementById("root")!, new ElectronHost());
