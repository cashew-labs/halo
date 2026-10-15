import fs from "node:fs/promises";
import path from "node:path";
import util from "node:util";
import childProcess from "node:child_process";
import { expect, test, vi } from "vitest";
import { AppProject } from "../AppProject.js";
import type { ExtensionArtifact } from "@get-halo/client";

const buildId = '01234567-1234-1234-1234-123456789abc';
const installId = '11111111-2222-3333-4444-555555555555';
const artifact: ExtensionArtifact = { files: { 'package.json': '{"name":"books"}', 'api.ts': 'export default {};', 'src/helper.sh': 'echo ok' }, assets: {}, build: { 'dist/start.mjs': Buffer.from('start').toString('base64'), 'dist/current.json': Buffer.from(JSON.stringify(buildId)).toString('base64'), [`dist/${buildId}/server.mjs`]: Buffer.from('server').toString('base64'), [`dist/${buildId}/public/index.html`]: Buffer.from('demo').toString('base64') }, data: '{"records":[]}' };
const projectTest = test.extend<{ project: AppProject; root: string; directory: string }>({
  root: async ({}, use) => {
    const parent = path.resolve(import.meta.dirname, '../../../../../tmp/extension-sharing');
    await fs.mkdir(parent, { recursive: true });
    const root = await fs.mkdtemp(path.join(parent, 'project-'));
    await use(root); await fs.rm(root, { recursive: true, force: true });
  },
  directory: async ({ root }, use) => await use(path.join(root, '.halo/extensions/books')),
  project: async ({ root }, use) => await use(new AppProject({ workspaceRoot: root, extensionId: 'books' })),
});

projectTest('project transfer excludes runtime secrets and validates source before writing', async ({ project, root, directory }) => {
  // SAFETY: deliberately malformed wire input exercises the validation boundary.
  expect(await project.install({ files: {} } as ExtensionArtifact, installId)).toBeInstanceOf(Error);
  expect(await project.install({ ...artifact, files: {} }, installId)).toBeInstanceOf(Error);
  expect(await project.install({ ...artifact, files: { ...artifact.files, '../secret.ts': 'x' } }, installId)).toBeInstanceOf(Error);
  expect(await project.install({ ...artifact, files: { ...artifact.files, 'big.ts': 'x'.repeat(16 * 1024 * 1024) } }, installId)).toBeInstanceOf(Error);
  expect(await project.install(artifact, installId)).toBeUndefined();
  await fs.writeFile(path.join(directory, '.env'), 'secret');
  await fs.writeFile(path.join(directory, 'ignored.bin'), 'opaque');
  const snapshot = await project.snapshot(); if (snapshot instanceof Error) throw snapshot;
  expect(snapshot.data).toBe(artifact.data);
  expect(snapshot.files['src/helper.sh']).toBe('echo ok');
  expect(snapshot.files).not.toHaveProperty('.env'); expect(snapshot.files).not.toHaveProperty('ignored.bin');
  expect(await project.write({ name: 'api.ts', contents: 'updated' })).toBeUndefined();
  expect(await project.read('api.ts')).toBe('updated');
  expect(await project.write({ name: 'api.ts', contents: '界'.repeat(8 * 1024 * 1024) })).toBeInstanceOf(Error);
  expect(await project.write({ name: 'api.ts', contents: 'x'.repeat(16 * 1024 * 1024 + 1) })).toBeInstanceOf(Error);
  expect(await project.read('missing.ts')).toBeInstanceOf(Error);
  await fs.symlink(path.join(root, 'secret.ts'), path.join(directory, 'link.ts'));
  expect(await project.read('link.ts')).toBeInstanceOf(Error);
  expect(await project.snapshot()).toBeInstanceOf(Error);
  await fs.rm(path.join(directory, 'link.ts'));
  await fs.mkdir(path.join(directory, 'folder.ts'));
  expect(await project.read('folder.ts')).toBeInstanceOf(Error);
  expect(await project.write({ name: 'folder.ts', contents: 'cannot replace directory' })).toBeInstanceOf(Error);
  expect(await project.write({ name: 'api.ts/nested.ts', contents: 'x' })).toBeInstanceOf(Error);
  await fs.writeFile(path.join(directory, 'dist/current.json'), '{');
  expect(await project.snapshot()).toBeInstanceOf(Error);
  await fs.writeFile(path.join(directory, 'dist/current.json'), '"../escape"');
  expect(await project.snapshot()).toBeInstanceOf(Error);
  await fs.rm(path.join(directory, 'dist/current.json'));
  expect(await project.snapshot()).toBeInstanceOf(Error);
});

projectTest('failed imports remove partial projects and preserve existing data', async ({ project, root, directory }) => {
  expect(await project.snapshot()).toBeInstanceOf(Error);
  const data = path.join(root, '.halo/extension-data/books');
  await fs.mkdir(data, { recursive: true }); await fs.writeFile(path.join(data, 'tandem.json'), 'existing data');
  expect(await project.install(artifact, installId)).toBeInstanceOf(Error);
  expect(await fs.readFile(path.join(data, 'tandem.json'), 'utf8')).toBe('existing data');
  expect(await fs.stat(directory).catch(() => undefined)).toBeUndefined();
  await fs.rm(data, { recursive: true }); await fs.writeFile(data, 'not a directory');
  expect(await project.install(artifact, installId)).toBeInstanceOf(Error);
  await fs.rm(data);
  await fs.mkdir(path.dirname(directory), { recursive: true });
  await fs.rm(path.dirname(directory), { recursive: true }); await fs.writeFile(path.dirname(directory), 'not a directory');
  expect(await project.install(artifact, installId)).toBeInstanceOf(Error);
});

projectTest('a failed data write removes the data file it created so the install can be retried', async ({ project, root, directory }) => {
  const open = fs.open;
  const spy = vi.spyOn(fs, 'open').mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    handle.writeFile = async () => { throw new Error('disk full'); };
    return handle;
  });
  expect(await project.install(artifact, installId)).toBeInstanceOf(Error);
  spy.mockRestore();
  expect(await fs.stat(path.join(root, '.halo/extension-data/books/tandem.json')).catch(() => undefined)).toBeUndefined();
  expect(await fs.stat(directory).catch(() => undefined)).toBeUndefined();
  expect(await project.install(artifact, installId)).toBeUndefined();
  expect(await fs.readFile(path.join(root, '.halo/extension-data/books/tandem.json'), 'utf8')).toBe('{"records":[]}');
});

projectTest('unsupported entries and excessive source are refused', async ({ project, directory }) => {
  expect(await project.install(artifact, installId)).toBeUndefined();
  const file = path.join(directory, 'big.ts');
  const handle = await fs.open(file, 'w'); await handle.truncate(16 * 1024 * 1024 + 1); await handle.close();
  expect(await project.read('big.ts')).toBeInstanceOf(Error); expect(await project.snapshot()).toBeInstanceOf(Error);
  await fs.rm(file);
  await util.promisify(childProcess.execFile)('mkfifo', [path.join(directory, 'pipe.ts')]);
  expect(await project.snapshot()).toBeInstanceOf(Error);
});

projectTest('filesystem permission failures remain errors and export size is bounded', async ({ project, root, directory }) => {
  expect(await project.install(artifact, installId)).toBeUndefined();
  expect(await project.snapshot({ contents: 'x'.repeat(16 * 1024 * 1024) })).toBeInstanceOf(Error);
  const data = path.join(root, '.halo/extension-data/books/tandem.json');
  await fs.rm(data); await fs.mkdir(data);
  expect(await project.snapshot()).toBeInstanceOf(Error);
  const protectedFile = path.join(directory, 'private.ts');
  await fs.writeFile(protectedFile, 'private', { mode: 0o000 });
  expect(await project.read('private.ts')).toBeInstanceOf(Error);
  await fs.chmod(protectedFile, 0o600);
  const protectedDirectory = path.join(directory, 'protected');
  await fs.mkdir(protectedDirectory, { mode: 0o555 });
  expect(await project.write({ name: 'protected/new.ts', contents: 'x' })).toBeInstanceOf(Error);
  expect(await project.write({ name: 'protected/nested/new.ts', contents: 'x' })).toBeInstanceOf(Error);
  await fs.chmod(protectedDirectory, 0o700);
  await fs.rm(data, { recursive: true });
  const oneMb = 'x'.repeat(1024 * 1024);
  for (let i = 0; i < 17; i++) await fs.writeFile(path.join(directory, `large-${i}.ts`), oneMb);
  expect(await project.snapshot()).toBeInstanceOf(Error);
});

projectTest('compiled output of every file type survives snapshot and install', async ({ root, project, directory }) => {
  expect(await project.install(artifact, installId)).toBeUndefined();
  const generated = { 'favicon.ico': 'ico', 'public/spinner.gif': 'gif', 'fonts/a.ttf': 'ttf', 'fonts/b.otf': 'otf', 'engine.wasm': 'wasm', 'worker.cjs': 'cjs', 'app.webmanifest': '{}', '.vite/manifest.json': '{}', 'LICENSE': 'MIT' };
  for (const [name, contents] of Object.entries(generated)) {
    await fs.mkdir(path.dirname(path.join(directory, 'dist', buildId, name)), { recursive: true });
    await fs.writeFile(path.join(directory, 'dist', buildId, name), contents);
  }
  await fs.mkdir(path.join(directory, 'public')); await fs.writeFile(path.join(directory, 'public/favicon.ico'), Buffer.from([0, 1, 2]));
  await fs.mkdir(path.join(directory, 'src/dist'), { recursive: true }); await fs.writeFile(path.join(directory, 'src/dist/nested.ts'), 'nested');
  const snapshot = await project.snapshot(); if (snapshot instanceof Error) throw snapshot;
  for (const [name, contents] of Object.entries(generated))
    expect(Buffer.from(snapshot.build[`dist/${buildId}/${name}`] ?? '', 'base64').toString()).toBe(contents);
  expect(snapshot.assets['public/favicon.ico']).toBe(Buffer.from([0, 1, 2]).toString('base64'));
  expect(snapshot.files['src/dist/nested.ts']).toBe('nested');
  const copy = new AppProject({ workspaceRoot: path.join(root, 'copy'), extensionId: 'books' });
  expect(await copy.install(snapshot, installId)).toBeUndefined();
  expect(await fs.readFile(path.join(root, 'copy/.halo/extensions/books/dist', buildId, 'engine.wasm'), 'utf8')).toBe('wasm');
  expect(await fs.readFile(path.join(root, 'copy/.halo/extensions/books/dist', buildId, '.vite/manifest.json'), 'utf8')).toBe('{}');
  // Build entries cannot escape dist/, and source entries cannot target it.
  const other = new AppProject({ workspaceRoot: path.join(root, 'other'), extensionId: 'books' });
  expect(await other.install({ ...artifact, build: { ...artifact.build, 'api.ts': 'eA==' } }, installId)).toBeInstanceOf(Error);
  expect(await other.install({ ...artifact, build: { ...artifact.build, 'dist/../escape.js': 'eA==' } }, installId)).toBeInstanceOf(Error);
  expect(await other.install({ ...artifact, files: { ...artifact.files, 'dist/start.mjs': 'x' } }, installId)).toBeInstanceOf(Error);
  expect(await other.install({ ...artifact, files: { ...artifact.files, 'image.png': 'not text' } }, installId)).toBeInstanceOf(Error);
  expect(await project.read('public/favicon.ico')).toBeInstanceOf(Error);
  await fs.symlink('/etc/passwd', path.join(directory, 'dist', buildId, 'leak.txt'));
  expect(String(await project.snapshot())).toContain('leak.txt');
});

projectTest('a retried install with the same install ID is a no-op, another one is refused', async ({ project, directory }) => {
  expect(await project.install(artifact, 'not-a-uuid')).toBeInstanceOf(Error);
  expect(await project.install(artifact, installId)).toBeUndefined();
  await fs.writeFile(path.join(directory, 'api.ts'), 'edited after install');
  expect(await project.install(artifact, installId)).toBeUndefined();
  expect(await fs.readFile(path.join(directory, 'api.ts'), 'utf8')).toBe('edited after install');
  expect(await project.install(artifact, '99999999-2222-3333-4444-555555555555')).toBeInstanceOf(Error);
  const snapshot = await project.snapshot(); if (snapshot instanceof Error) throw snapshot;
  expect(Object.keys(snapshot.files)).not.toContain('.install-id');
});

projectTest('snapshot and install share one entry limit across source and build', async ({ project, root, directory }) => {
  expect(await project.install(artifact, installId)).toBeUndefined();
  // 200 source files and 60 build files: each pass is under 256, the total is not.
  for (let index = 0; index < 197; index += 1) await fs.writeFile(path.join(directory, `module${index}.ts`), 'export {};');
  for (let index = 0; index < 58; index += 1) await fs.writeFile(path.join(directory, `dist/${buildId}/chunk${index}.mjs`), 'export {};');
  const tooMany = await project.snapshot();
  expect(tooMany).toBeInstanceOf(Error);
  expect(String(tooMany)).toContain('256-file');
  // Whatever snapshot produces at the limit installs into a fresh project.
  for (let index = 0; index < 10; index += 1) await fs.rm(path.join(directory, `module${index}.ts`));
  const atLimit = await project.snapshot(); if (atLimit instanceof Error) throw atLimit;
  expect(Object.keys(atLimit.files).length + Object.keys(atLimit.assets).length + Object.keys(atLimit.build).length).toBeLessThanOrEqual(256);
  const copy = new AppProject({ workspaceRoot: path.join(root, 'copy'), extensionId: 'books' });
  expect(await copy.install(atLimit, installId)).toBeUndefined();
});
