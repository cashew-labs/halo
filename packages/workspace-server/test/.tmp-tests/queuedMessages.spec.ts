import { expect } from 'vitest';
import { m } from '@get-halo/shared/testing';
import { sessionMessages } from '@get-halo/client';
import { messageText } from '@get-halo/workspace-server/testing';
import { serverTest } from '../serverTest.js';

serverTest('withdraws only queued inputs, keeps other work running, and rejects invalid IDs', async ({ server, llm }) => {
  const session = await server.rpc.thread.new();
  const active = await server.rpc.thread.prompt({ ...session, text: 'Original request' });
  await llm.waitForRequest();
  const first = await server.rpc.thread.prompt({ ...session, text: 'Remove this request' });
  const second = await server.rpc.thread.prompt({ ...session, text: 'Keep this request' });
  await expect(server.rpc.thread.withdraw({ ...session, submissionId: 0 })).rejects.toThrow('Invalid submission ID');
  await expect(server.rpc.thread.withdraw({ ...session, submissionId: Number.MAX_SAFE_INTEGER })).rejects.toThrow('Unknown thread submission');
  expect(await server.rpc.thread.withdraw({ ...session, ...active })).toEqual({ withdrawn: false });
  expect(await server.rpc.thread.withdraw({ ...session, ...first })).toEqual({ withdrawn: true });
  expect(await server.rpc.thread.withdraw({ ...session, ...first })).toEqual({ withdrawn: false });
  expect(await server.rpc.thread.wait({ ...session, ...first })).toMatchObject({ status: 'aborted' });
  expect((await server.rpc.thread.snapshot(session)).activeRun).toBeDefined();
  await llm.respond(m.assistant('Original finished.'));
  await llm.respond(({ messages }) => {
    expect(messages.filter(message => message.role === 'user').map(messageText)).toEqual(['Original request', 'Keep this request']);
    return m.assistant('Remaining request finished.');
  });
  await server.rpc.thread.wait({ ...session, ...second });
  expect(await server.rpc.thread.withdraw({ ...session, ...second })).toEqual({ withdrawn: false });
  const snapshot = await server.rpc.thread.snapshot(session);
  expect(sessionMessages(snapshot).some(message => message.role === 'custom' && message.customType === 'halo.user.interruption')).toBe(false);
  await server.stop();
  await server.start();
  expect(await server.rpc.thread.snapshot(session)).toEqual(snapshot);
});

serverTest('records one interruption for concurrent Stop requests and retains it after another turn and restart', async ({ server, llm }) => {
  const session = await server.rpc.thread.new();
  await server.rpc.thread.abort(session);
  expect(sessionMessages(await server.rpc.thread.snapshot(session))).toEqual([]);
  const active = await server.rpc.thread.prompt({ ...session, text: 'Start an answer' });
  await llm.waitForRequest();
  await Promise.all([server.rpc.thread.abort(session), server.rpc.thread.abort(session)]);
  expect(await server.rpc.thread.wait({ ...session, ...active })).toMatchObject({ status: 'aborted' });
  const interrupted = await server.rpc.thread.snapshot(session);
  const markers = sessionMessages(interrupted).filter(message => message.role === 'custom' && message.customType === 'halo.user.interruption');
  expect(markers).toHaveLength(1);
  await server.rpc.thread.abort(session);
  const next = await server.rpc.thread.prompt({ ...session, text: 'Continue' });
  await llm.respond(({ messages }) => {
    expect(messages.map(messageText).join('\n')).not.toContain('Interrupted by user');
    return m.assistant('Continued.');
  });
  await server.rpc.thread.wait({ ...session, ...next });
  const snapshot = await server.rpc.thread.snapshot(session);
  expect(sessionMessages(snapshot).filter(message => message.role === 'custom' && message.customType === 'halo.user.interruption')).toHaveLength(1);
  await server.stop();
  await server.start();
  expect(await server.rpc.thread.snapshot(session)).toEqual(snapshot);
});

for (const failure of ['withdraw', 'interruption'] as const) serverTest(`returns a useful RPC failure when the durable harness rejects ${failure}`, async ({ server, llm }) => {
  const { Harness } = await import('@earendil-works/pi-durable');
  const { vi } = await import('vitest');
  const open = Harness.open.bind(Harness);
  vi.spyOn(Harness, 'open').mockImplementation(async (...args) => {
    const harness = await open(...args);
    if (failure === 'withdraw') vi.spyOn(harness, 'abortSubmission').mockRejectedValueOnce(new Error('Injected storage failure'));
    if (failure === 'interruption') {
      const root = harness.root.bind(harness);
      vi.spyOn(harness, 'root').mockImplementation(async (...rootArgs) => {
        const conversation = await root(...rootArgs);
        const submit = conversation.submit.bind(conversation);
        vi.spyOn(conversation, 'submit').mockImplementation(async (draft, context) => {
          if (draft.type === 'write' && draft.requestId?.startsWith('halo.interrupted:')) throw new Error('Injected storage failure');
          return await submit(draft, context);
        });
        return conversation;
      });
    }
    return harness;
  });
  try {
    const session = await server.rpc.thread.new();
    await server.rpc.thread.prompt({ ...session, text: 'Start work' });
    await llm.waitForRequest();
    if (failure === 'withdraw') {
      const queued = await server.rpc.thread.prompt({ ...session, text: 'Queued work' });
      await expect(server.rpc.thread.withdraw({ ...session, ...queued })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Could not withdraw queued message' });
      expect(await server.rpc.thread.withdraw({ ...session, ...queued })).toEqual({ withdrawn: true });
    } else {
      await expect(server.rpc.thread.abort(session)).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Could not save interruption' });
      expect((await server.rpc.thread.snapshot(session)).activeRun).toBeUndefined();
    }
  } finally { vi.restoreAllMocks(); }
});
