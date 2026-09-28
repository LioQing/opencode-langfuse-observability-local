import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import plugin from './receiver/index.js';

test('Git package does not trigger npm dependency preparation', async () => {
  const { scripts, workspaces } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(workspaces, undefined);
  for (const name of ['postinstall', 'build', 'preinstall', 'install', 'prepack', 'prepare']) {
    assert.equal(scripts[name], undefined, `npm prepares Git dependencies with a ${name} script`);
  }
});

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('V2 plugin starts one receiver, shares it, and stops only its own child', async () => {
  const oldPort = process.env.PORT;
  const oldDataDir = process.env.DATA_DIR;
  const oldRetentionDays = process.env.RETENTION_DAYS;
  const port = await freePort();
  let ignoredPort = await freePort();
  while (ignoredPort === port) ignoredPort = await freePort();
  const directory = await mkdtemp(join(tmpdir(), 'opencode-receiver-'));
  process.env.PORT = String(ignoredPort);
  process.env.DATA_DIR = directory;
  process.env.RETENTION_DAYS = '1';
  const kept = '2026-08-01-00-00-00-ses_kept.jsonl';
  await writeFile(join(directory, kept), '{}\n');
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000);
  await utimes(join(directory, kept), twoDaysAgo, twoDaysAgo);
  const url = `http://127.0.0.1:${port}/dashboard`;
  let first;
  let second;
  try {
    [first, second] = await Promise.all([
      plugin.setup({ options: { port, retentionDays: 7 } }), plugin.setup({ options: { port, retentionDays: 7 } }),
    ]);
    await assert.rejects(plugin.setup({ options: { port: ignoredPort } }), /already configured/);
    await assert.rejects(plugin.setup({ options: { port, retentionDays: 5 } }), /already configured with retentionDays/);
    assert.match(await (await fetch(url)).text(), /Session observatory/);
    assert.deepEqual(await readdir(directory), [kept]);
    await assert.rejects(fetch(`http://127.0.0.1:${ignoredPort}/dashboard`));
    await first();
    assert.equal((await fetch(url)).status, 200);
    await second();
    second = undefined;
    for (let i = 0; i < 30; i++) {
      try {
        await fetch(url);
      } catch {
        break;
      }
      if (i === 29) assert.fail('receiver did not stop on cleanup');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    if (second) await second();
    if (oldPort === undefined) delete process.env.PORT;
    else process.env.PORT = oldPort;
    if (oldDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = oldDataDir;
    if (oldRetentionDays === undefined) delete process.env.RETENTION_DAYS;
    else process.env.RETENTION_DAYS = oldRetentionDays;
    await rm(directory, { recursive: true, force: true });
  }
});

test('V2 plugin leaves an already-running receiver alone', async () => {
  const oldPort = process.env.PORT;
  const port = await freePort();
  process.env.PORT = String(port);
  const { createApp } = await import('../dist/app.js');
  const directory = await mkdtemp(join(tmpdir(), 'opencode-receiver-existing-'));
  const app = createApp(undefined, directory);
  try {
    await app.listen({ host: '127.0.0.1', port });
    const cleanup = await plugin.setup({ options: { port } });
    await cleanup();
    assert.equal((await fetch(`http://127.0.0.1:${port}/dashboard`)).status, 200);
  } finally {
    await app.close();
    if (oldPort === undefined) delete process.env.PORT;
    else process.env.PORT = oldPort;
    await rm(directory, { recursive: true, force: true });
  }
});

test('V2 plugin rejects invalid port options', async () => {
  for (const port of [0, -1, 65536, '3000', 2.5, null]) {
    await assert.rejects(plugin.setup({ options: { port } }), /port must be an integer/);
  }
});

test('V2 plugin rejects invalid retention options', async () => {
  for (const retentionDays of [0, -1, 2.5, '7', null, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(plugin.setup({ options: { retentionDays } }), /retentionDays must be a positive integer/);
  }
});
