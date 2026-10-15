import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { AppSandbox } from "../AppSandbox.js";

type Driver = { sandbox: AppSandbox; replies: Record<string, { status?: number; body?: string; destroy?: boolean; handle?: (response: http.ServerResponse) => void }> };
const protocolTest = test.extend<{ driver: Driver }>({
  driver: async ({}, use) => {
    const directory = path.resolve(import.meta.dirname, "../../../../../tmp/extension-sharing");
    await fs.mkdir(directory, { recursive: true });
    const socketPath = path.relative(process.cwd(), path.join(directory, `protocol-${randomUUID().slice(0, 8)}`));
    const replies: Driver["replies"] = {};
    const server = http.createServer((request, response) => {
      request.resume();
      const reply = replies[request.url!] ?? { body: '{"stopped":true}' };
      if (reply.destroy) { response.writeHead(200); response.write('partial'); response.destroy(); return; }
      if (reply.handle) { reply.handle(response); return; }
      response.writeHead(reply.status ?? 200).end(reply.body ?? '{}');
    });
    server.listen(socketPath); await once(server, "listening");
    await use({ sandbox: new AppSandbox({ socketPath }), replies });
    vi.useRealTimers();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(socketPath, { force: true });
  },
});
const input = { extensionId: "books", brokerPort: 8788, toolToken: "t".repeat(32), hostToken: "h".repeat(32), syncAccess: "actions" as const };

protocolTest("sandbox refuses invalid, oversized and failed startup replies", async ({ driver }) => {
  for (const reply of [{ body: '{"url":"https://evil.test/view/"}' }, { body: '{' }, { status: 400, body: '{"error":"runtime unavailable"}' }, { body: 'x'.repeat(17000) }, { destroy: true }]) {
    driver.replies['/start'] = reply;
    expect(await driver.sandbox.start(input)).toBeInstanceOf(Error);
  }
  expect(await new AppSandbox({ socketPath: "tmp/no-such-sandbox.sock" }).start(input)).toBeInstanceOf(Error);
});

protocolTest("supervisor data and command results are validated", async ({ driver }) => {
  for (const operation of ['snapshot', 'exec']) {
    driver.replies['/' + operation] = { body: '{"unexpected":true}' };
    expect(await (operation === 'snapshot' ? driver.sandbox.snapshot('books') : driver.sandbox.execute({ extensionId: 'books', command: 'npm run build' }))).toBeInstanceOf(Error);
    driver.replies['/' + operation] = { status: 400, body: '{}' };
    expect(await (operation === 'snapshot' ? driver.sandbox.snapshot('books') : driver.sandbox.execute({ extensionId: 'books', command: 'npm run build' }))).toBeInstanceOf(Error);
  }
});

protocolTest("a delayed health reply cannot resurrect a stopped app", async ({ driver }) => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  driver.replies['/start'] = { body: '{"url":"http://127.0.0.1:1234/view/"}' };
  const app = await driver.sandbox.start(input); if (app instanceof Error) throw app;
  const responses: http.ServerResponse[] = [];
  driver.replies['/status'] = { handle: (response) => { responses.push(response); } };
  await vi.advanceTimersByTimeAsync(2000);
  await expect.poll(() => responses.length).toBe(1);
  await vi.advanceTimersByTimeAsync(2000);
  expect(responses.length).toBe(1);
  expect(await app.stop()).toBeUndefined();
  responses[0]!.end('{"running":true}');
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  expect(app.isRunning()).toBe(false);
});

protocolTest("a supervisor outage keeps the last state until it reports the app stopped", async ({ driver }) => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  driver.replies['/start'] = { body: '{"url":"http://127.0.0.1:1234/view/"}' };
  const app = await driver.sandbox.start(input); if (app instanceof Error) throw app;
  for (const reply of [{ body: '{}' }, { status: 400, body: '{"error":"restarting"}' }, { destroy: true }]) {
    driver.replies['/status'] = reply;
    await vi.advanceTimersByTimeAsync(2000);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(app.isRunning()).toBe(true);
  }
  driver.replies['/status'] = { body: '{"running":false}' };
  await vi.advanceTimersByTimeAsync(2000);
  await expect.poll(() => app.isRunning()).toBe(false);
});

protocolTest("health failures remove running authority and shutdown failures are reported", async ({ driver }) => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  driver.replies['/start'] = { body: '{"url":"http://127.0.0.1:1234/view/"}' };
  for (const status of ['{"running":true}', '{"running":false}']) {
    const app = await driver.sandbox.start(input); if (app instanceof Error) throw app;
    driver.replies['/status'] = { body: status };
    await vi.advanceTimersByTimeAsync(2000);
    if (status.includes('true')) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(app.isRunning()).toBe(true);
    } else await expect.poll(() => app.isRunning()).toBe(false);
    driver.replies['/stop'] = { body: '{}' };
    expect(await app.stop()).toBeInstanceOf(Error);
    driver.replies['/stop'] = { status: 400, body: '{}' };
    expect(await app.stop()).toBeInstanceOf(Error);
  }
});


protocolTest('truncated responses are reported as transport failures', async ({ driver }) => {
  driver.replies['/start'] = { handle: (response) => { response.writeHead(200); response.write('{'); setTimeout(() => response.destroy(), 20); } };
  expect(await driver.sandbox.start(input)).toBeInstanceOf(Error);
});

protocolTest('a silent supervisor times out rather than holding an app operation indefinitely', async ({ driver }) => {
  driver.replies['/start'] = { handle: () => {} };
  expect(await driver.sandbox.start(input)).toBeInstanceOf(Error);
}, 45000);
