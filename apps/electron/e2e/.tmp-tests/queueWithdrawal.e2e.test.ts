import { expect, type Locator } from '@playwright/test';
import { e2eTest } from '../e2eTest.js';
import { m } from '@get-halo/shared/testing';

type TransportControl = { holdPath?: string; failPath?: string; releases: (() => void)[]; failures: number };
const queueTest = e2eTest.extend<{ queued: { pane: Locator; editor: Locator; remove: Locator; transport: TransportControl } }>({
  queued: async ({ app, harness, llm }, use) => {
    const transport: TransportControl = { releases: [], failures: 0 };
    await app.page.routeWebSocket('**/rpc/socket*', socket => {
      const server = socket.connectToServer();
      socket.onMessage(message => {
        const frame = message.toString();
        if (transport.failPath !== undefined && frame.includes(transport.failPath)) {
          transport.failPath = undefined;
          transport.failures++;
          socket.close({ code: 1011, reason: 'Injected network failure' });
          server.close();
          return;
        }
        if (transport.holdPath !== undefined && frame.includes(transport.holdPath)) {
          transport.releases.push(() => server.send(message));
          return;
        }
        server.send(message);
      });
    });
    await harness.loadSession({ title: 'Queue withdrawal edge cases', messages: [m.user('Hello'), m.assistant('Ready.')] });
    const pane = app.page.getByRole('main', { name: 'Queue withdrawal edge cases' });
    const editor = pane.getByLabel('Message', { exact: true });
    await editor.fill('Original request');
    await pane.getByRole('button', { name: 'Send', exact: true }).click();
    await llm.waitForRequest();
    await editor.fill('Queued instruction');
    await pane.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    await editor.fill('Keep existing draft');
    const remove = pane.getByRole('button', { name: 'Move queued message to draft', exact: true });
    await expect(remove).toBeEnabled();
    await use({ pane, editor, remove, transport });
  },
});

queueTest('retains the queue and draft after a failed request, then restores on retry', async ({ app, queued }) => {
  queued.transport.failPath = '/thread/withdraw';
  await queued.remove.click();
  await expect.poll(() => queued.transport.failures).toBe(1);
  await expect(queued.remove).toBeEnabled();
  await expect(queued.editor).toHaveText('Keep existing draft');
  await expect(queued.pane.getByRole('log')).toContainText('Queued instruction');
  await expect(app.page.getByRole('status', { name: 'Connection: Connected', exact: true })).toBeVisible();
  await queued.remove.click();
  await expect(queued.remove).not.toBeVisible();
  await expect(queued.editor).toContainText('Keep existing draft');
  await expect(queued.editor).toContainText('Queued instruction');
});

queueTest('does not restore a message the agent picked up while withdrawal was in transit', async ({ app, queued, llm }) => {
  queued.transport.holdPath = '/thread/withdraw';
  await queued.remove.click();
  await expect.poll(() => queued.transport.releases.length).toBe(1);
  await queued.editor.press('ControlOrMeta+Enter');
  await llm.respond(m.assistant('Original request finished.'));
  await llm.waitForRequest();
  await expect(queued.remove).not.toBeVisible();
  queued.transport.holdPath = undefined;
  queued.transport.releases[0]!();
  await expect(queued.pane.getByRole('alert')).toContainText('already been picked up');
  await expect(queued.editor).toHaveText('Keep existing draft');
  await llm.respond(m.assistant('Queued instruction received once.'));
  await expect(queued.pane.getByRole('log')).toContainText('Queued instruction received once.');
  await expect(queued.pane.getByRole('article', { name: 'You message' }).filter({ hasText: 'Queued instruction' })).toHaveCount(1);
});

queueTest('keeps queued messages when Stop fails and removes them after a successful stop', async ({ app, queued }) => {
  await queued.editor.press('ControlOrMeta+A');
  await queued.editor.press('Backspace');
  await expect(queued.editor).toBeEmpty();
  await queued.editor.press('ControlOrMeta+Enter');
  queued.transport.failPath = '/thread/abort';
  await queued.pane.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect.poll(() => queued.transport.failures).toBe(1);
  await expect(queued.remove).toBeEnabled();
  await expect(app.page.getByRole('status', { name: 'Connection: Connected', exact: true })).toBeVisible();
  await queued.pane.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(queued.pane.getByText('Interrupted by user', { exact: true })).toBeVisible();
  await expect(queued.remove).not.toBeVisible();
  await expect(queued.pane.getByRole('alert')).not.toBeVisible();
});

queueTest('a failed queued send restores its draft without dropping earlier queued messages', async ({ app, queued }) => {
  await app.page.route('**/rpc/thread/prompt', route => route.abort('failed'));
  await queued.pane.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(queued.editor).toHaveAttribute('contenteditable', 'true');
  await expect(queued.editor).toHaveText('Keep existing draft');
  await expect(queued.remove).toHaveCount(1);
  await expect(queued.pane.getByRole('log')).toContainText('Queued instruction');
});

queueTest('leaves a message queued when restoring its files would exceed the composer attachment limit', async ({ queued }) => {
  await queued.pane.getByLabel('Attach files', { exact: true }).setInputFiles(Array.from({ length: 10 }, (_, index) => ({ name: `queued-${index}.txt`, mimeType: 'text/plain', buffer: Buffer.from('A tiny attachment') })));
  await queued.pane.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(queued.editor).toHaveAttribute('contenteditable', 'true');
  await queued.editor.fill('New draft');
  await queued.pane.getByLabel('Attach files', { exact: true }).setInputFiles({ name: 'draft.txt', mimeType: 'text/plain', buffer: Buffer.from('Existing attachment') });
  await expect(queued.remove).toHaveCount(2);
  await queued.remove.last().click();
  await expect(queued.pane.getByRole('alert')).toContainText('Attach up to 10 files');
  await expect(queued.remove).toHaveCount(2);
  await expect(queued.editor).toHaveText('New draft');
  await queued.pane.getByRole('button', { name: 'Remove draft.txt', exact: true }).click();
  await queued.remove.last().click();
  await expect(queued.remove).toHaveCount(1);
  await expect(queued.pane.getByRole('list', { name: 'Attachments', exact: true }).getByRole('listitem')).toHaveCount(10);
  await expect(queued.editor).toContainText('New draft');
  await expect(queued.editor).toContainText('Keep existing draft');
});

for (const fresh of [false, true]) queueTest(`a transport abort does not show an error for a ${fresh ? 'new' : 'current'} chat prompt`, async ({ app, queued }) => {
  if (fresh) await app.page.getByRole('button', { name: 'New tab', exact: true }).click();
  const pane = fresh ? app.page.getByRole('main') : queued.pane;
  const editor = pane.getByLabel('Message', { exact: true });
  await editor.fill('Draft retained after transport abort');
  await app.page.evaluate(() => {
    const actualFetch = window.fetch;
    window.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes('/thread/prompt')) return Promise.reject(new DOMException('Injected transport abort', 'AbortError'));
      return actualFetch(input, init);
    };
  });
  await pane.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await expect(editor).toHaveText('Draft retained after transport abort');
  await expect(pane.getByRole('alert')).not.toBeVisible();
});
