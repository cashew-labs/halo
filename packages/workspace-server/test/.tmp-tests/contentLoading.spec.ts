import { expect } from "vitest";
import { serverTest } from "../serverTest.js";
import fs from "node:fs/promises";
import path from "node:path";

serverTest(
  "returns editable text in its preview without another file read",
  async ({ server }) => {
    for (const content of ["", "# Hello\n\nRésumé 🌍\n"]) {
      await server.rpc.workspace.writeFile({ path: "note.md", content });
      expect(
        await server.rpc.workspace.previewFile({ path: "note.md" }),
      ).toEqual({ kind: "text", content });
    }
    await fs.writeFile(
      path.join(server.workspaceRoot, "binary.bin"),
      Buffer.from([0, 255]),
    );
    expect(
      await server.rpc.workspace.previewFile({ path: "binary.bin" }),
    ).toMatchObject({ kind: "unsupported" });
    await fs.writeFile(
      path.join(server.workspaceRoot, "large.txt"),
      "x".repeat(5 * 1024 * 1024 + 1),
    );
    expect(
      await server.rpc.workspace.previewFile({ path: "large.txt" }),
    ).toMatchObject({ kind: "unsupported" });
  },
);

