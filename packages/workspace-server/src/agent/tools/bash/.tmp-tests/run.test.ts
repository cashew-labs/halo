import { expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runBash, BashTimeoutError } from '../run.js';

const root = path.resolve(import.meta.dirname, '../../../../../../../tmp/stop-queue');
const bashTest = test.extend<{ directory: string }>({
  // oxlint-disable-next-line eslint/no-empty-pattern -- Vitest fixture signature.
  directory: async ({}, use) => {
    await fs.mkdir(root, { recursive: true });
    const directory = await fs.mkdtemp(path.join(root, 'bash-'));
    await use(directory);
    await fs.rm(directory, { recursive: true, force: true });
  },
});

for (const mode of ['abort', 'timeout'] as const) {
  bashTest(`kills an orphaned setsid child ignoring SIGTERM on ${mode}`, async ({ directory }) => {
    const pidFile = path.join(directory, 'child.pid');
    const child = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
    const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { detached: true, stdio: ['ignore', 1, 2] }).unref()`;
    const controller = new AbortController();
    const result = runBash(directory, {
      command: `exec '${process.execPath}' -e '${parent.replaceAll("'", "'\\''")}'`,
      signal: controller.signal,
      timeoutMs: mode === 'timeout' ? 1500 : 10_000,
      output: { directory, headChars: 1000, tailChars: 1000 },
    });
    let childPid = 0;
    try {
      await expect.poll(async () => {
        const contents = await fs.readFile(pidFile, 'utf8').catch(() => '');
        childPid = Number(contents);
        return childPid > 0;
      }).toBe(true);
      if (mode === 'abort') controller.abort();
      const finished = await result;
      expect(finished).toBeInstanceOf(mode === 'timeout' ? BashTimeoutError : Error);
      await expect.poll(() => {
        try { process.kill(childPid, 0); return true; } catch { return false; }
      }).toBe(false);
    } finally {
      controller.abort();
      if (childPid > 0) { try { process.kill(childPid, 'SIGKILL'); } catch { /* Already gone. */ } }
      await result;
    }
  });
}

bashTest('preserves normal output and rejects an already aborted command', async ({ directory }) => {
  const output = { directory, headChars: 1000, tailChars: 1000 };
  expect(await runBash(directory, { command: 'printf hello', output })).toMatchObject({ code: 0, stdout: 'hello' });
  const signal = AbortSignal.abort();
  expect(await runBash(directory, { command: 'touch should-not-exist', output, signal })).toBeInstanceOf(Error);
  expect(await fs.readdir(directory)).not.toContain('should-not-exist');
});

bashTest('cancels even when a child removes its inherited identity and holds a pipe', async ({ directory }) => {
  const pidFile = path.join(directory, 'untagged.pid');
  const code = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
  const parent = `const env = {...process.env}; delete env.HALO_BASH_RUN_ID; require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(code)}], { env, detached: true, stdio: ['ignore', 1, 2] }).unref()`;
  const controller = new AbortController();
  const result = runBash(directory, { command: `exec '${process.execPath}' -e '${parent.replaceAll("'", "'\\''")}'`, signal: controller.signal, output: { directory, headChars: 1000, tailChars: 1000 } });
  await expect.poll(async () => fs.readFile(pidFile, 'utf8').catch(() => '')).not.toBe('');
  const pid = Number(await fs.readFile(pidFile, 'utf8'));
  try {
    controller.abort();
    expect(await result).toBeInstanceOf(Error);
  } finally {
    process.kill(pid, 'SIGKILL');
  }
});

for (const failure of ['process-list', 'process-group', 'exited-group'] as const) {
  bashTest(`still stops a command when ${failure} signalling is unavailable`, async ({ directory }) => {
    const pidFile = path.join(directory, 'fallback.pid');
    const code = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
    const originalPath = process.env.PATH;
    const realKill = process.kill.bind(process);
    if (failure === 'process-list') {
      await fs.writeFile(path.join(directory, 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      process.env.PATH = `${directory}:${originalPath}`;
    }
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    if (failure !== 'process-list') vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid < 0) throw Object.assign(new Error('Process group is unavailable'), { code: failure === 'exited-group' ? 'ESRCH' : 'EPERM' });
      return realKill(pid, signal);
    });
    const controller = new AbortController();
    const result = runBash(directory, { command: `exec '${process.execPath}' -e '${code.replaceAll("'", "'\\''")}'`, signal: controller.signal, output: { directory, headChars: 1000, tailChars: 1000 } });
    await expect.poll(async () => fs.readFile(pidFile, 'utf8').catch(() => '')).not.toBe('');
    const pid = Number(await fs.readFile(pidFile, 'utf8'));
    try {
      controller.abort();
      expect(await result).toBeInstanceOf(Error);
      expect(() => realKill(pid, 0)).toThrow();
      if (failure === 'exited-group') expect(warnings).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    }
  });
}

for (const mode of ['abort', 'timeout'] as const) {
  bashTest(`kills an untagged same-group child after the shell exits on ${mode}`, async ({ directory }) => {
    const pidFile = path.join(directory, 'same-group.pid');
    const code = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
    const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(code)}], { env: {}, stdio: ['ignore', 1, 2] }).unref()`;
    const controller = new AbortController();
    const result = runBash(directory, {
      command: `exec '${process.execPath}' -e '${parent.replaceAll("'", "'\\''")}'`,
      signal: controller.signal,
      timeoutMs: mode === 'timeout' ? 1500 : 10_000,
      output: { directory, headChars: 1000, tailChars: 1000 },
    });
    await expect.poll(async () => fs.readFile(pidFile, 'utf8').catch(() => '')).not.toBe('');
    const pid = Number(await fs.readFile(pidFile, 'utf8'));
    try {
      // Let the spawning shell exit before cancellation starts.
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (mode === 'abort') controller.abort();
      expect(await result).toBeInstanceOf(mode === 'timeout' ? BashTimeoutError : Error);
      await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }).toBe(false);
    } finally {
      controller.abort();
      try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone. */ }
      await result;
    }
  });
}
