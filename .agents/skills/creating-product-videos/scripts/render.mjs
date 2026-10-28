import path from "node:path";
import { mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { bundle } from "@remotion/bundler";
import {
  renderMedia,
  renderStill,
  selectComposition,
} from "@remotion/renderer";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    video: { type: "boolean", default: false },
    frames: { type: "string" },
    browser: { type: "string" },
    help: { type: "boolean", default: false },
  },
});
if (values.help || positionals.length !== 3) {
  console.log(
    "Usage: node render.mjs <entry.tsx> <composition-id> <output.mp4> [--frames 0,30,60] [--browser /path/to/chrome] [--video]",
  );
  process.exit(values.help ? 0 : 1);
}

const [entry, id, output] = positionals;
const entryPoint = path.resolve(entry);
const directory = path.dirname(entryPoint);
const serveUrl = await bundle({
  entryPoint,
  publicDir: path.join(directory, "public"),
  outDir: path.join(directory, "bundle"),
  webpackOverride: (config) => ({
    ...config,
    module: {
      ...config.module,
      rules: [
        ...config.module.rules,
        { test: /\.m?js$/, resolve: { fullySpecified: false } },
      ],
    },
  }),
});
const browserExecutable = values.browser;
const composition = await selectComposition({
  serveUrl,
  id,
  browserExecutable,
});
const frames = values.frames
  ? values.frames.split(",").map(Number)
  : [
      0,
      Math.floor(composition.durationInFrames / 2),
      composition.durationInFrames - 1,
    ];
if (
  frames.some(
    (frame) =>
      !Number.isInteger(frame) ||
      frame < 0 ||
      frame >= composition.durationInFrames,
  )
) {
  throw new Error(
    `Review frames must be integers from 0 to ${composition.durationInFrames - 1}.`,
  );
}
console.log(
  `Composition: ${composition.width}×${composition.height}, ${composition.durationInFrames / composition.fps}s`,
);
const review = path.join(directory, "review");
await mkdir(review, { recursive: true });
for (const frame of frames) {
  await renderStill({
    serveUrl,
    composition,
    browserExecutable,
    frame,
    output: path.join(review, `frame-${frame}.png`),
  });
  console.log(`Rendered review frame ${frame}`);
}
if (values.video) {
  const outputLocation = path.resolve(output);
  await mkdir(path.dirname(outputLocation), { recursive: true });
  await renderMedia({
    serveUrl,
    composition,
    browserExecutable,
    codec: "h264",
    crf: 18,
    concurrency: 2,
    outputLocation,
  });
  console.log(`Video rendered: ${outputLocation}`);
}
