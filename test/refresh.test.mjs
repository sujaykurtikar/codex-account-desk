import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function startServer(t, env) {
  const data = await mkdtemp(join(tmpdir(), 'account-desk-refresh-'));
  const child = spawn(process.execPath, [join(root, 'server.mjs')], {
    env: { ...process.env, PORT: '0', ACCOUNT_DESK_DATA: data, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { child.kill('SIGTERM'); await once(child, 'exit'); await rm(data, { recursive: true, force: true }); });
  let output = '';
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server start timed out')), 10000);
    child.stdout.on('data', chunk => { output += chunk; const m = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (m) { clearTimeout(timeout); resolve(m[0]); } });
    child.once('error', reject);
  });
  const api = async (path, method = 'GET', body) => {
    const r = await fetch(url + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json() };
  };
  return { api, output: () => output };
}

test('refresh answers immediately instead of holding the request open', async t => {
  const { api } = await startServer(t, {});
  const started = Date.now();
  const refresh = await api('/api/refresh', 'POST', {});
  const elapsed = Date.now() - started;
  assert.equal(refresh.status, 200);
  assert.ok(elapsed < 2000, `refresh must answer immediately, took ${elapsed}ms`);
  assert.equal((await api('/api/state')).status, 200, 'server keeps serving after a refresh');
});

// The fake codex is a POSIX script, so the child-process part only runs on Linux/macOS.
test('refresh syncs accounts in the background', { skip: process.platform === 'win32' ? 'fake codex needs a POSIX shell' : false }, async t => {
  const fake = join(root, 'test/fake-codex.mjs');
  await chmod(fake, 0o755);
  const { api } = await startServer(t, { CODEX_BIN: fake });
  const created = await api('/api/accounts', 'POST', {});
  const id = created.data.accounts[0].id;
  await api('/api/accounts/' + id + '/connect', 'POST', {});
  await new Promise(r => setTimeout(r, 800));
  const before = (await api('/api/state')).data.accounts[0].updatedAt;
  assert.ok(before, 'account is connected before refreshing');
  await api('/api/refresh', 'POST', {});
  let after = before, waited = 0;
  while (after === before && waited < 20000) {
    await new Promise(r => setTimeout(r, 500));
    after = (await api('/api/state')).data.accounts[0].updatedAt;
    waited += 500;
  }
  assert.notEqual(after, before, 'account data was refreshed in the background');
  assert.equal((await api('/api/state')).status, 200, 'server keeps serving after a refresh');
});
