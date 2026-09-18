import { Logger } from "@get-halo/logger";
import { ConsoleLoggerSink } from "@get-halo/logger/ConsoleLoggerSink";
import { mountHaloApp } from "@get-halo/web/mountHaloApp";
import { ElectronHost } from "./ElectronHost.js";
import { WindowMessageLoggerSink } from "./WindowMessageLoggerSink.js";

mountHaloApp({
  root: document.getElementById("root")!,
  host: new ElectronHost(),
  logger: new Logger({
    sinks: [new ConsoleLoggerSink(), new WindowMessageLoggerSink()],
  }),
});
