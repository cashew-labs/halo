import { readFile, writeFile } from "node:fs/promises";

import { Resvg } from "@resvg/resvg-js";
import React from "react";
import satori from "satori";

const width = 1200;
const height = 630;
const headline = [
  "An open-source, self-modifiable,",
  "agentic operating system.",
];

const [donut, font] = await Promise.all([
  readFile(new URL("../public/halo-donut-transparent.png", import.meta.url)),
  readFile(
    new URL(
      import.meta
        .resolve("@fontsource/inter/files/inter-latin-400-normal.woff"),
    ),
  ),
]);
const donutSource = `data:image/png;base64,${donut.toString("base64")}`;

for (const theme of ["dark", "light"]) {
  const background = theme === "dark" ? "#111111" : "#fcfcfc";
  const foreground = theme === "dark" ? "#eeeeee" : "#202020";
  const svg = await satori(
    React.createElement(
      "div",
      {
        style: {
          display: "flex",
          position: "relative",
          width,
          height,
          backgroundColor: background,
        },
      },
      React.createElement("img", {
        src: donutSource,
        width: 108,
        height: 108,
        style: { position: "absolute", left: 77, top: 72 },
      }),
      React.createElement(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            position: "absolute",
            left: 88,
            top: 282,
            color: foreground,
            fontFamily: "Inter",
            fontSize: 46,
            fontWeight: 400,
            letterSpacing: -1.4,
            lineHeight: 1.27,
          },
        },
        ...headline.map((line) =>
          React.createElement("div", { key: line }, line),
        ),
      ),
    ),
    {
      width,
      height,
      fonts: [{ name: "Inter", data: font, weight: 400, style: "normal" }],
    },
  );
  const png = new Resvg(svg).render().asPng();
  await writeFile(new URL(`../public/og-${theme}.png`, import.meta.url), png);
}
