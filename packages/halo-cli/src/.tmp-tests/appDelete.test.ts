import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import events from "node:events";
import type { AddressInfo } from "node:net";
import { expect, test } from "vitest";
import { haloProtocolVersion } from "@get-halo/client";
import { writeHaloRpcFile } from "@get-halo/shared/HaloRpcFile";
import { app } from "../app.js";

const cliTest = test.extend<{
  cli: {
    run: () => Promise<string>;
    failure: { message: string | undefined };
    requests: string[];
  };
}>({
  // oxlint-disable-next-line eslint/no-empty-pattern -- Native fixture signature.
  cli: async ({}, use) => {
    const parent = path.resolve(
      import.meta.dirname,
      "../../../../tmp/published-app-deletion",
    );
    await fs.mkdir(parent, { recursive: true });
    const directory = await fs.mkdtemp(path.join(parent, "cli-"));
    const failure: { message: string | undefined } = { message: undefined };
    const requests: string[] = [];
    const server = http.createServer((request, response) => {
      if (request.url?.startsWith("/rpc/server/info")) {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            json: {
              protocolVersion: haloProtocolVersion,
              supportedProtocols: [haloProtocolVersion],
            },
          }),
        );
        return;
      }
      requests.push(request.url ?? "");
      response.setHeader("content-type", "application/json");
      if (failure.message !== undefined) {
        response.writeHead(400).end(
          JSON.stringify({
            json: {
              defined: false,
              inferable: true,
              code: "BAD_REQUEST",
              message: failure.message,
            },
          }),
        );
        return;
      }
      response.end('{"json":null}');
    });
    server.listen(0, "127.0.0.1");
    await events.once(server, "listening");
    const written = await writeHaloRpcFile({
      userDataDir: directory,
      connection: {
        port: (server.address() as AddressInfo).port,
        token: "test",
      },
    });
    if (written instanceof Error) throw written;
    await use({
      failure,
      requests,
      run: async () => {
        const output: string[] = [];
        await app.serve(
          [
            "delete",
            "da65d61e-541d-4168-9ef8-c5b9db4aa30d",
            "--format",
            "json",
          ],
          {
            env: { HALO_USER_DATA: directory },
            stdout: (text) => {
              output.push(text);
            },
            exit: () => {},
          },
        );
        return output.join("");
      },
    });
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      ),
    );
    await fs.rm(directory, { recursive: true });
  },
});

cliTest(
  "delete reports completion and preserves the server's unpublish instruction",
  async ({ cli }) => {
    expect(await cli.run()).toContain(
      '"deleted": "da65d61e-541d-4168-9ef8-c5b9db4aa30d"',
    );
    expect(cli.requests).toContain("/rpc/apps/delete");
    cli.failure.message = "Unpublish this app before deleting it.";
    expect(await cli.run()).toContain("Unpublish this app before deleting it.");
  },
);
