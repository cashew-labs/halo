#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

const skill = url.fileURLToPath(new URL("../", import.meta.url));
const repo = process.cwd();
const usage =
  "Usage: node <flow-preview-skill>/scripts/generate.mjs <lowercase-name> [port]";

async function generate() {
  const [name, requestedPort = "4180", ...extra] = process.argv.slice(2);
  if (name === "--help") {
    console.log(
      `${usage}\nCreates tmp/<name> in the current directory. Default port: 4180.`,
    );
    return;
  }
  if (
    !name ||
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name) ||
    extra.length > 0
  ) {
    return new Error(usage);
  }
  const port = Number(requestedPort);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return new Error("Choose an available port from 1024 to 65535.");
  }
  const temporaryRoot = await fs
    .mkdir(path.join(repo, "tmp"), { recursive: true })
    .catch(
      (cause) =>
        new Error(
          "Could not create tmp/. Check the current directory permissions.",
          { cause },
        ),
    );
  if (temporaryRoot instanceof Error) return temporaryRoot;
  const directory = path.join(repo, "tmp", name);
  const created = await fs
    .mkdir(directory)
    .catch(
      (cause) =>
        new Error(
          `Could not create tmp/${name}. Choose a new name if it already exists. Existing previews are never overwritten.`,
          { cause },
        ),
    );
  if (created instanceof Error) return created;
  const title = name
    .split("-")
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
  const metadata = await fs
    .readFile(path.join(skill, "package.json"), "utf8")
    .then(JSON.parse)
    .catch(
      (cause) =>
        new Error("Could not read the skill's package.json.", { cause }),
    );
  if (metadata instanceof Error) return metadata;
  const files = {
    "package.json":
      JSON.stringify(
        {
          name: `flow-preview-${name}`,
          private: true,
          type: "module",
          scripts: {
            dev: "vite --config vite.config.mjs",
            build: "vite build",
          },
          dependencies: metadata.dependencies,
        },
        null,
        2,
      ) + "\n",
    "index.html": `<!doctype html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${title}</title></head>
<body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>
`,
    "vite.config.mjs": `import { fileURLToPath } from "node:url";
import { previewConfig } from "./previewConfig.mjs";
export default previewConfig({ directory: fileURLToPath(new URL(".", import.meta.url)), port: ${port} });
`,
    "main.tsx": `import { useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { MauiProvider, useTheme } from "maui";
import { FlowCanvas } from "./FlowCanvas.js";
import { scenario } from "./scenario.js";

const requestedTheme = new URLSearchParams(location.search).get("theme");
function Preview() {
  const { setPreference } = useTheme();
  useLayoutEffect(() => {
    if (requestedTheme === "light" || requestedTheme === "dark") setPreference(requestedTheme);
  }, [setPreference]);
  return <FlowCanvas scenario={scenario} />;
}
createRoot(document.getElementById("root")!).render(<MauiProvider><Preview /></MauiProvider>);
`,
    "scenario.tsx": `import { useState } from "react";
import { Button, Flex, Text, TextField } from "maui";
import type { FlowScenario } from "./FlowCanvas.js";

// Replace this small local example with fixtures and an adapter for the real component.
// Keep requests and mutations local to the preview; thumbnails must be deterministic.
function Preferences({ saved = false }: { saved?: boolean }) {
  const [name, setName] = useState("Morning digest");
  const [complete, setComplete] = useState(saved);
  return (
    <Flex column gap={8} padding={8} style={{ minHeight: 260 }}>
      <Text fontWeight={600}>Notification preferences</Text>
      <TextField aria-label="Digest name" value={name} onChange={setName} />
      <Button onPress={() => setComplete(true)}>Save preferences</Button>
      {complete && <Text role="status">Preferences saved</Text>}
    </Flex>
  );
}

export const scenario: FlowScenario = {
  id: "${name}",
  title: "${title}",
  description: "Edit the scenario to describe a real user journey.",
  notice: "Local fixtures only. No production data is changed.",
  initialState: "editing",
  dimensions: { nodeHeight: 140, previewWidth: 360 },
  nodes: [
    { id: "editing", title: "Editing preferences", action: "Open preferences", row: 0,
      render: () => <Preferences /> },
    { id: "saved", title: "Preferences saved", parent: "editing", action: "Save preferences", row: 0,
      render: () => <Preferences saved /> },
  ],
};
`,
  };
  for (const filename of ["FlowCanvas.tsx", "previewConfig.mjs"]) {
    const copied = await fs
      .copyFile(
        path.join(skill, "assets", filename),
        path.join(directory, filename),
        fs.constants.COPYFILE_EXCL,
      )
      .catch(
        (cause) =>
          new Error(
            `Could not copy ${filename} from the skill. Keep the entire skill folder together.`,
            { cause },
          ),
      );
    if (copied instanceof Error) return copied;
  }
  for (const [filename, contents] of Object.entries(files)) {
    const written = await fs
      .writeFile(path.join(directory, filename), contents, { flag: "wx" })
      .catch(
        (cause) =>
          new Error(
            `Could not write tmp/${name}/${filename}. Check directory permissions.`,
            { cause },
          ),
      );
    if (written instanceof Error) return written;
  }
  console.log(`Created tmp/${name}/scenario.tsx — edit the states and real-component adapter here.

Install this preview's dependencies (no workspace configuration required):
npm --prefix tmp/${name} install --workspaces=false

From the same directory, start a supervised portal:
amp orb service start flow-${name} --command 'npm --prefix tmp/${name} run dev' --port ${port} --portal

Share the portal URL printed by Amp, not a loopback URL.
Inspect: amp orb service logs flow-${name}
Stop: amp orb service stop flow-${name}`);
}

const generated = await generate();
if (generated instanceof Error) {
  console.error(generated.message);
  process.exitCode = 1;
}
