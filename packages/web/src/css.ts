import type { Globals } from "csstype";

declare module "csstype" {
  interface Properties<TLength = (string & {}) | 0, TTime = string & {}> {
    WebkitAppRegion?: Globals | "drag" | "no-drag";
  }
}
