import { Logger } from "@get-halo/logger";
import { ConsoleLoggerSink } from "@get-halo/logger/ConsoleLoggerSink";
import { mountHaloApp } from "@get-halo/web/mountHaloApp";
import { WebHost } from "./WebHost.js";

mountHaloApp({
  root: document.getElementById("root")!,
  host: new WebHost(),
  logger: new Logger({
    sinks: [new ConsoleLoggerSink()],
  }).scope("web"),
});
