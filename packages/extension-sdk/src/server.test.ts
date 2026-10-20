import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { serveExtension } from "./server.js";
import { defineSchema, defineRelations, collection, t } from "./schema.js";

const schema = defineSchema({
  links: collection({ id: t.id(), url: t.string() }),
});
const relations = defineRelations(schema, () => ({}));
const httpTest = test.extend<{ origin: string; httpEnabled: boolean }>({
  httpEnabled: true,
  origin: async ({ httpEnabled }, use) => {
    await fs.mkdir(path.resolve(import.meta.dirname, "../../../tmp"), {
      recursive: true,
    });
    const root = await fs.mkdtemp(
      path.resolve(import.meta.dirname, "../../../tmp/http-extension-"),
    );
    const running = await serveExtension({
      router: {},
      schema,
      relations,
      publicDirectory: root,
      dataDirectory: root,
      port: 0,
      hostToken: "internal-secret",
      http: !httpEnabled
        ? undefined
        : (request, context) => {
            expect(Object.keys(context)).toEqual(["storage"]);
            const url = new URL(request.url);
            if (url.pathname === "/body-error")
              return new Response(
                new ReadableStream({
                  start(controller) {
                    controller.error(new Error("response failed"));
                  },
                }),
              );
            if (url.pathname === "/error") throw new Error("handler failed");
            if (url.pathname === "/unsafe")
              return new Response(undefined, {
                status: 302,
                headers: { location: "javascript:alert(1)" },
              });
            if (url.pathname !== "/launch")
              return new Response(undefined, { status: 404 });
            return new Response("redirect body", {
              status: 302,
              headers: {
                location: `https://example.org/?${url.searchParams}`,
                "set-cookie": "private=bad",
              },
            });
          },
    });
    if (running instanceof Error) throw running;
    try {
      await use(new URL(running.url).origin);
    } finally {
      await running.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
});

// Durable: exposing HTTP must not bypass Halo's internal authentication or leak identity.
httpTest(
  "serves redirects without exposing owner context and preserves campaign parameters",
  async ({ origin }) => {
    expect((await fetch(`${origin}/http/launch`)).status).toBe(401);
    const headers = {
      "x-halo-extension-token": "internal-secret",
      "x-halo-viewer-role": "owner",
    };
    const response = await fetch(`${origin}/http/launch?utm_source=mail`, {
      headers,
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://example.org/?utm_source=mail",
    );
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(
      (
        await fetch(`${origin}/http/launch`, {
          headers,
          method: "HEAD",
          redirect: "manual",
        })
      ).status,
    ).toBe(302);
    expect(
      (await fetch(`${origin}/http/launch`, { headers, method: "POST" }))
        .status,
    ).toBe(405);
    expect((await fetch(`${origin}/http/missing`, { headers })).status).toBe(
      404,
    );
    expect(
      (await fetch(`${origin}/http/unsafe`, { headers, redirect: "manual" }))
        .status,
    ).toBe(500);
  },
);

httpTest.extend({ httpEnabled: false })(
  "returns 404 without a declared HTTP handler",
  async ({ origin }) => {
    expect(
      (
        await fetch(`${origin}/http/launch`, {
          headers: { "x-halo-extension-token": "internal-secret" },
        })
      ).status,
    ).toBe(404);
  },
);

httpTest(
  "returns 500 for handler and response-body failures without stopping the server",
  async ({ origin }) => {
    const headers = { "x-halo-extension-token": "internal-secret" };
    expect((await fetch(`${origin}/http/error`, { headers })).status).toBe(500);
    expect((await fetch(`${origin}/http/body-error`, { headers })).status).toBe(
      500,
    );
    expect(
      (await fetch(`${origin}/http/launch`, { headers, redirect: "manual" }))
        .status,
    ).toBe(302);
  },
);

httpTest(
  "preserves the readiness route outside the HTTP surface",
  async ({ origin }) => {
    const response = await fetch(`${origin}/__halo/ready`, {
      headers: { "x-halo-extension-token": "internal-secret" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ protocol: 1 });
  },
);
