import { mountHaloApp } from "@get-halo/web/mountHaloApp";
import { electronHost } from "./ElectronHost.js";

mountHaloApp(document.getElementById("root")!, electronHost);
