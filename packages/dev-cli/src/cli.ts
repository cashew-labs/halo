import { Cli } from "incur";
import { app } from "./app.js";

await Cli.create("halo-dev", {
  description: "Develop and inspect Halo locally",
  version: "dev",
})
  .command(app)
  .serve();
