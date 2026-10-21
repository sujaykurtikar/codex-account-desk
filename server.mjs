import http from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, writeFile, rename, mkdir, chmod, rm, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHmac, timingSafeEqual, createHash } from 'node:crypto';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(process.env.ACCOUNT_DESK_DATA || join(homedir(), '.local/share/codex-account-desk'));
const PORT = Number(process.env.PORT || 4317);
import { existsSync } from 'node:fs';

const startedAt = Date.now();
const defaultCodex = existsSync(join(ROOT, 'node_modules/.bin/codex'))
  ? join(ROOT, 'node_modules/.bin/codex')
  : (existsSync('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex')
    ? '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
    : 'codex');
const CODEX = process.env.CODEX_BIN || defaultCodex;
const PRODUCTION = process.env.NODE_ENV === 'production';
const ACCESS_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
if (PRODUCTION && (!ACCESS_PASSWORD || SESSION_SECRET.length < 32 || !process.env.RENDER_EXTERNAL_HOSTNAME)) throw new Error('Set DASHBOARD_PASSWORD, SESSION_SECRET, and RENDER_EXTERNAL_HOSTNAME before deploying.');
await mkdir(DATA, { recursive: true, mode: 0o700 });
await chmod(DATA, 0o700);
const MONGO_URI = process.env.MONGODB_URI || '';
console.log(`Account Desk: mirror ${MONGO_URI ? `ENABLED (${MONGO_URI.slice(0, 29)}...)` : 'OFF - MONGODB_URI not set'}`);
let keepMirror = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Declared up top: the boot-time restore path runs before the helpers below are initialised.
const message = e => (e.message || 'Request failed').replace(/Bearer\s+\S+/gi, '[redacted]').slice(0, 240);
// One shared client: mirrorCol used to open a new MongoClient per save and never close it — that leaked
// connection pools until the process died.
let mongoClient = null, mongoCol = null;
async function mirrorCol() {
  if (!MONGO_URI) return null;
  if (mongoCol) return mongoCol;
  try {
    const m = await import('mongodb');
    mongoClient = new m.MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000, maxPoolSize: 5 });
    await mongoClient.connect();
    mongoCol = mongoClient.db('account_desk').collection('snapshot');
    return mongoCol;
  } catch (e) {
    console.error('MongoDB connect failed:', message(e));
    await resetMongo();
    return null;
  }
}
async function resetMongo() {
  try { await mongoClient?.close(); } catch {}
  mongoClient = null; mongoCol = null;
}
async function collectFiles() {
  // ponytail: snapshot only top-level profile files under 200KB — covers auth.json/config.toml; nested session dirs are not persisted
  const files = {};
  for (const id of state.accounts.map(a => a.id)) {
    const home = profilePath(id);
    let entries; try { entries = await readdir(home, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile()) continue;
      try {
        const p = join(home, e.name);
        if ((await stat(p)).size > 200 * 1024) continue;
        files[`profiles/${id}/${e.name}`] = (await readFile(p)).toString('base64');
      } catch {}
    }
  }
  return files;
}
async function pushMirror() {
  if (!MONGO_URI || keepMirror) return;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const col = await mirrorCol();
    if (!col) { if (attempt < 3) await sleep(5000 * attempt); continue; }
    try {
      await col.updateOne({ _id: 'snapshot' }, { $set: { state, files: await collectFiles() } }, { upsert: true });
      return;
    } catch (e) {
      console.error(`Mirror push failed (attempt ${attempt}):`, message(e));
      await resetMongo();
      if (attempt < 3) await sleep(5000 * attempt);
    }
  }
}
async function restoreMirror() {
  if (!MONGO_URI) return;
  let col = await mirrorCol();
  if (!col) { await sleep(5000); col = await mirrorCol(); }
  if (!col) throw new Error('MongoDB unreachable');
  const doc = await col.findOne({ _id: 'snapshot' });
  if (!doc?.state?.accounts) return;
  state = JSON.parse(JSON.stringify(doc.state));
  for (const [path, b64] of Object.entries(doc.files || {})) {
    const target = join(DATA, ...path.split('/'));
    if (existsSync(target)) continue;
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, Buffer.from(b64, 'base64'), { mode: 0o600 });
  }
  console.log(`Restored ${doc.state.accounts.length} account(s) from MongoDB.`);
}
let state;
try { state = JSON.parse(await readFile(join(DATA, 'state.json'), 'utf8')); }
catch (e) {
  // With the mirror enabled a corrupt state.json falls back to the MongoDB restore below instead of crash-looping.
  if (e.code !== 'ENOENT' && !MONGO_URI) throw new Error('Cannot read saved state. Check state.json before restarting.');
  state = { accounts: [], activeId: null, settings: { reserve: 10, strategy: 'balanced', bucket: 'auto' } };
}
if (state.accounts.length === 5 && state.accounts.every((a, i) => a.label === `Account ${String(i + 1).padStart(2, '0')}` && !a.email && !a.connected && !a.updatedAt)) state.accounts = [];
if (state.accounts.length === 0 && state.activeId === null) {
  // Never let a slow Atlas hold the boot hostage: give up after 10s and keep the mirror disabled
  // (keepMirror) so an empty state can never overwrite the real one.
  try {
    await Promise.race([restoreMirror(), sleep(10000).then(() => { throw new Error('MongoDB restore timed out'); })]);
  } catch (e) {
    if (MONGO_URI) { console.error('MongoDB restore skipped, updates will not sync until restart:', e.message || String(e)); keepMirror = true; }
  }
}
const clients = new Map(), syncing = new Map();
// ponytail: each codex child costs ~90MB and the free instance caps at 512MiB — keep at most two warm
const MAX_CLIENTS = 2;
let writes = Promise.resolve(), pendingLogin = null;
const loginAttempts = new Map();
const COOKIE = 'account_desk_session', SESSION_TTL = 30 * 24 * 60 * 60;
function signature(payload) { return createHmac('sha256', SESSION_SECRET || 'local-session').update(payload).digest('base64url'); }
function validSession(req) {
  if (!ACCESS_PASSWORD) return !PRODUCTION;
  const raw = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!raw) return false;
  const [payload, token] = raw.split('.');
  if (!payload || !token) return false;
  const expected = Buffer.from(signature(payload)), supplied = Buffer.from(token);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return false;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString()).expires > Date.now(); } catch { return false; }
}
function requireSession(req) { if (!validSession(req)) fail('Sign in to use the shared dashboard.', 401); }
function save() {
  const snapshot = JSON.stringify(state, null, 2);
  const operation = writes.catch(() => {}).then(async () => {
    await writeFile(join(DATA, 'state.tmp'), snapshot, { mode: 0o600 });
    await rename(join(DATA, 'state.tmp'), join(DATA, 'state.json'));
  });
  writes = operation.then(() => pushMirror().catch(e => console.error('Mirror push failed:', message(e))));
  return operation;
}
const shellQuote = text => "'" + text.replaceAll("'", "'\\''") + "'";
const profilePath = id => join(DATA, 'profiles', id);
const publicState = () => ({ ...state, remoteProfiles: PRODUCTION, accounts: state.accounts.map(a => ({ ...a, command: PRODUCTION ? null : `CODEX_HOME=${shellQuote(profilePath(a.id))} ${CODEX.includes(' ') ? shellQuote(CODEX) : CODEX}` })) });
function fail(text, code = 400) { const e = new Error(text); e.status = code; throw e; }
function find(id) { return state.accounts.find(a => a.id === id) || fail('Account not found', 404); }
function normalizeWindow(w) {
  if (!w) return null;
  const used = w.usedPercent;
  return { usedPercent: typeof used === 'number' && Number.isFinite(used) ? Math.max(0, Math.min(100, used)) : null, windowDurationMins: typeof w.windowDurationMins === 'number' ? w.windowDurationMins : null, resetsAt: typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) ? w.resetsAt : null };
}
function normalizedLimits(data) {
  const normalize = l => ({ primary: normalizeWindow(l?.primary), secondary: normalizeWindow(l?.secondary) });
  const buckets = Object.entries(data.rateLimitsByLimitId || {}).map(([key, l]) => ({ key, label: l.limitName || key, ...normalize(l) }));
  const defaultBucket = buckets.find(b => b.key === 'codex') || buckets[0];
  return { limits: normalize(defaultBucket || data.rateLimits), buckets };
}
class Client {
  constructor(account) {
    this.account = account;
    this.pending = new Map(); this.seq = 0; this.closed = false;
  }
  async start() {
    const home = profilePath(this.account.id);
    await mkdir(home, { recursive: true, mode: 0o700 });
    // Force profile-local storage rather than sharing the system keychain.
    await writeFile(join(home, 'config.toml'), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
    this.child = spawn(CODEX, ['app-server', '--stdio', '-c', 'cli_auth_credentials_store="file"'], { env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    this.child.stderr.resume();
    this.child.stdin.on('error', e => this.stop(e));
    this.child.once('error', e => this.stop(new Error(e.code === 'ENOENT' ? 'Codex CLI not found. Set CODEX_BIN or install Codex CLI.' : 'Codex app server could not start.')));
    this.child.once('exit', () => this.stop(new Error('Codex connection closed. Try Refresh.')));
    createInterface({ input: this.child.stdout }).on('line', line => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id); clearTimeout(timer);
        msg.error ? reject(new Error(msg.error.message || 'Codex rejected the request')) : resolve(msg.result);
      } else if (msg.id !== undefined) {
        this.child.stdin.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: 'Unsupported request' } }) + '\n');
      } else if (msg.method === 'account/login/completed') {
        if (pendingLogin?.id === this.account.id) pendingLogin = null;
        if (msg.params?.success) syncAccount(this.account).catch(() => {});
        else { this.account.error = msg.params?.error || 'Sign-in was cancelled'; save().catch(() => {}); }
      }
    });
    await this.request('initialize', { clientInfo: { name: 'account_desk', title: 'Account Desk', version: '1.0.0' } });
    this.child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    return this;
  }
  request(method, params = null) {
    if (this.closed) return Promise.reject(new Error('Codex connection closed'));
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex request timed out. Try Refresh.')); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  stop(error = new Error('Disconnected')) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    // Kill the whole process group: codex spawns helpers, and orphans kept eating the 512MiB instance.
    if (this.child?.pid) { try { process.kill(-this.child.pid, 'SIGKILL'); } catch { try { this.child.kill('SIGKILL'); } catch {} } }
    else this.child?.kill();
    clients.delete(this.account.id);
  }
}
async function clientFor(account) {
  const existing = clients.get(account.id);
  if (existing) { clients.delete(account.id); clients.set(account.id, existing); return existing; }
  const p = new Client(account).start();
  clients.set(account.id, p);
  p.catch(() => { if (clients.get(account.id) === p) clients.delete(account.id); });
  // LRU pool: warm clients make a refresh ~0.3s instead of ~3s, and the cap keeps the 512MiB instance safe.
  while (clients.size > MAX_CLIENTS) {
    const oldest = [...clients.keys()].find(id => id !== pendingLogin?.id);
    if (!oldest) break;
    const victim = clients.get(oldest);
    clients.delete(oldest);
    victim.then(c => c.stop()).catch(() => {});
  }
  return p;
}
async function syncAccount(account) {
  if (syncing.has(account.id)) return syncing.get(account.id);
  const task = (async () => {
    try {
      const client = await clientFor(account);
      const { account: identity } = await client.request('account/read', { refreshToken: false });
      if (!identity || identity.type !== 'chatgpt') throw new Error('Sign in with a ChatGPT subscription to read limits.');
      const email = identity.email || '';
      const duplicate = state.accounts.find(a => a !== account && a.connected && email && a.email.toLowerCase() === email.toLowerCase());
      if (duplicate) {
        Object.assign(account, { email, label: email, source: 'manual', connected: false, error: 'This email is already listed.' });
        clients.get(account.id)?.stop();
        await save();
        return;
      }
      const data = await client.request('account/rateLimits/read');
      if (!state.accounts.includes(account)) return;
      const before = JSON.stringify([account.email, account.plan, account.limits, account.buckets, account.error]);
      Object.assign(account, normalizedLimits(data), { email, label: email || account.label, plan: identity.planType || 'ChatGPT', source: 'codex', connected: true, error: null, updatedAt: new Date().toISOString() });
      if (JSON.stringify([account.email, account.plan, account.limits, account.buckets, account.error]) === before) return;
    } catch (e) {
      if (state.accounts.includes(account)) account.error = message(e);
    }
    await save();
  })().finally(() => {
    syncing.delete(account.id);
  });
  syncing.set(account.id, task);
  return task;
}
// All syncs run through one queue: only one codex child is busy at a time, so the 512MiB instance never starves.
let chain = Promise.resolve();
let fullPass = null;
const enqueue = task => { chain = chain.then(task).catch(() => {}); return chain; };
function refreshAll() {
  if (!fullPass) {
    fullPass = enqueue(async () => {
      const accounts = state.accounts.filter(a => a.source === 'codex');
      for (const a of accounts) {
        await syncAccount(a).catch(() => {});
        // ponytail: pause between accounts — the free instance has a tiny CPU quota and a 5-account
        // burst starves the web server (state calls went from 0.8s to 38s)
        await new Promise(r => setTimeout(r, 4000));
      }
    }).finally(() => { fullPass = null; });
  }
  return fullPass;
}
async function body(req) {
  let text = '';
  for await (const part of req) { text += part; if (text.length > 100000) fail('Request too large', 413); }
  try { return text ? JSON.parse(text) : {}; } catch { fail('Invalid JSON'); }
}
function string(v, max = 160) { if (typeof v !== 'string' || v.length > max) fail('Invalid text field'); return v.trim(); }
function validateWindow(w) {
  if (w === null) return null;
  if (!w || typeof w !== 'object') fail('Invalid usage window');
  if (w.usedPercent !== null && (typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100)) fail('Usage must be between 0 and 100');
  if (w.resetsAt !== null && (typeof w.resetsAt !== 'number' || !Number.isFinite(w.resetsAt) || w.resetsAt <= 0)) fail('Invalid reset time');
  if (typeof w.windowDurationMins !== 'number' || !Number.isFinite(w.windowDurationMins) || w.windowDurationMins <= 0) fail('Invalid window duration');
  return normalizeWindow(w);
}
async function api(req, path) {
  if (req.method === 'GET' && path === '/api/session') return { requiresLogin: !!ACCESS_PASSWORD, loggedIn: validSession(req) };
  if (req.method === 'POST' && path === '/api/session/login') {
    const data = await body(req);
    const ip = req.socket.remoteAddress || 'unknown', now = Date.now(), attempt = loginAttempts.get(ip) || { count: 0, since: now };
    if (now - attempt.since > 15 * 60000) { attempt.count = 0; attempt.since = now; }
    attempt.count++;
    loginAttempts.set(ip, attempt);
    if (attempt.count > 10) fail('Too many attempts. Try again in 15 minutes.', 429);
    const submitted = createHash('sha256').update(String(data.password || '')).digest();
    const expected = createHash('sha256').update(ACCESS_PASSWORD).digest();
    if (!ACCESS_PASSWORD || !timingSafeEqual(submitted, expected)) fail('That shared password did not match.', 401);
    loginAttempts.delete(ip);
    const payload = Buffer.from(JSON.stringify({ expires: Date.now() + SESSION_TTL * 1000, nonce: randomUUID() })).toString('base64url');
    return { loggedIn: true, cookie: `${COOKIE}=${payload}.${signature(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL}` };
  }
  if (req.method === 'POST' && path === '/api/session/logout') return { loggedOut: true, cookie: `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` };
  requireSession(req);
  if (req.method === 'GET' && path === '/api/state') return publicState();
  const data = await body(req);
  if (req.method === 'POST' && path === '/api/accounts') {
    if (state.accounts.length >= 100) fail('Maximum 100 profiles');
    const account = { id: randomUUID(), label: string(data.label || 'Awaiting sign-in'), email: '', plan: '', source: 'manual', connected: false, updatedAt: null, error: null, limits: { primary: null, secondary: null }, buckets: [] };
    state.accounts.push(account); await save(); return publicState();
  }
  if (req.method === 'PATCH' && path === '/api/settings') {
    const next = { ...state.settings, ...data };
    if (!['balanced', 'capacity', 'reset'].includes(next.strategy) || typeof next.reserve !== 'number' || !Number.isFinite(next.reserve) || next.reserve < 0 || next.reserve > 99 || typeof next.bucket !== 'string' || next.bucket.length > 160) fail('Invalid settings');
    state.settings = { reserve: next.reserve, strategy: next.strategy, bucket: next.bucket }; await save(); return publicState();
  }
  if (req.method === 'POST' && path === '/api/active') {
    if (data.id !== null) find(data.id);
    state.activeId = data.id; await save(); return publicState();
  }
  if (req.method === 'POST' && path === '/api/refresh') { if (data.id) find(data.id); if (data.id) enqueue(() => syncAccount(find(data.id))); else refreshAll(); return publicState(); }
  const route = path.match(/^\/api\/accounts\/([a-zA-Z0-9-]+)(?:\/(connect|disconnect|cancel-login|import-local))?$/);
  if (!route) fail('Not found', 404);
  const account = find(route[1]);
  if (req.method === 'POST' && route[2] === 'import-local') {
    const localAuth = join(homedir(), '.codex', 'auth.json');
    if (!existsSync(localAuth)) fail('No local Codex login found in ~/.codex/auth.json', 404);
    const home = profilePath(account.id);
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(join(home, 'config.toml'), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
    const authContent = await readFile(localAuth, 'utf8');
    await writeFile(join(home, 'auth.json'), authContent, { mode: 0o600 });
    const oldClient = await clients.get(account.id);
    oldClient?.stop();
    account.source = 'codex';
    account.error = null;
    await syncAccount(account);
    return publicState();
  }
  if (req.method === 'POST' && route[2] === 'connect') {
    if (pendingLogin && Date.now() - pendingLogin.at < 600000) fail(`Finish sign-in for ${find(pendingLogin.id).label} first.`, 409);
    if (pendingLogin) { const old = await clients.get(pendingLogin.id); await old?.request('account/login/cancel', { loginId: pendingLogin.loginId }).catch(() => {}); pendingLogin = null; }
    pendingLogin = { id: account.id, at: Date.now() };
    try {
      const client = await clientFor(account);
      const requestedType = data.type === 'device' || PRODUCTION ? 'chatgptDeviceCode' : 'chatgpt';
      const result = await client.request('account/login/start', { type: requestedType });
      if (pendingLogin?.id === account.id) pendingLogin.loginId = result.loginId;
      account.source = 'codex'; account.error = null; await save();
      if (result.authUrl) {
        return { type: 'chatgpt', authUrl: result.authUrl, verificationUrl: result.authUrl };
      }
      const url = new URL(result.verificationUrl);
      if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com' || !result.userCode) fail('Unexpected sign-in response');
      return { type: 'chatgptDeviceCode', verificationUrl: result.verificationUrl, userCode: result.userCode };
    } catch (e) { pendingLogin = null; throw e; }
  }
  if (req.method === 'POST' && route[2] === 'cancel-login') {
    if (pendingLogin?.id === account.id) {
      const client = await clients.get(account.id);
      await client?.request('account/login/cancel', { loginId: pendingLogin.loginId }).catch(() => {});
      pendingLogin = null;
      client?.stop();
    }
    return publicState();
  }
  if (req.method === 'POST' && route[2] === 'disconnect') {
    await syncing.get(account.id);
    const client = await clients.get(account.id);
    if (client) { await client.request('account/logout'); client.stop(); }
    await rm(join(profilePath(account.id), 'auth.json'), { force: true });
    Object.assign(account, { source: 'manual', connected: false, error: null, updatedAt: null, limits: { primary: null, secondary: null }, buckets: [] });
    if (pendingLogin?.id === account.id) pendingLogin = null;
    await save(); return publicState();
  }
  if (route[2]) fail('Method not allowed', 405);
  if (req.method === 'PATCH') {
    const patch = {};
    for (const key of ['label', 'email', 'plan']) if (key in data) patch[key] = string(data[key]);
    if (account.source === 'codex' && 'email' in patch && patch.email !== account.email) fail('The signed-in email is managed by OpenAI.');
    if ('limits' in data) {
      if (account.source === 'codex') fail('Disconnect before entering manual usage');
      patch.limits = { primary: validateWindow(data.limits?.primary), secondary: validateWindow(data.limits?.secondary) };
      patch.updatedAt = new Date().toISOString(); patch.error = null;
    }
    Object.assign(account, patch); await save(); return publicState();
  }
  if (req.method === 'DELETE') {
    const client = await clients.get(account.id);
    client?.stop();
    if (pendingLogin?.id === account.id) pendingLogin = null;
    state.accounts = state.accounts.filter(a => a !== account);
    if (state.activeId === account.id) state.activeId = null;
    await save(); await rm(profilePath(account.id), { recursive: true, force: true }); return publicState();
  }
  fail('Method not allowed', 405);
}
const staticFiles = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/styles.css': ['styles.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'], '/logic.js': ['logic.js', 'text/javascript'] };
const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, `http://${req.headers.host}`).pathname;
    if ((req.method === 'GET' || req.method === 'HEAD') && path === '/api/health') { res.statusCode = 200; res.setHeader('Content-Type', 'text/plain'); res.end('ok'); return; }
    const host = req.headers.host || '';
    const localHosts = [`127.0.0.1:${server.address()?.port}`, `localhost:${server.address()?.port}`];
    if (PRODUCTION ? host.split(':')[0].toLowerCase() !== process.env.RENDER_EXTERNAL_HOSTNAME.toLowerCase() : !localHosts.includes(host)) fail('Invalid host', 403);
    if (req.headers.origin && new URL(req.headers.origin).host.toLowerCase() !== host.toLowerCase()) fail('Invalid origin', 403);
    if (req.headers['sec-fetch-site'] === 'cross-site') fail('Cross-site request denied', 403);
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (req.method === 'GET' && path === '/healthz') { res.statusCode = 200; res.end('ok'); return; }
    if (path.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');
      const result = await api(req, path);
      if (result.cookie) {
        if (PRODUCTION && req.headers['x-forwarded-proto'] === 'https') result.cookie = result.cookie.replace('; SameSite=Lax', '; Secure; SameSite=Lax');
        res.setHeader('Set-Cookie', result.cookie);
      }
      delete result.cookie;
      res.end(JSON.stringify(result));
    } else if (req.method === 'GET' && staticFiles[path]) {
      const [file, type] = staticFiles[path]; res.setHeader('Content-Type', `${type}; charset=utf-8`); res.end(await readFile(join(ROOT, file)));
    } else fail('Not found', 404);
  } catch (e) {
    res.statusCode = e.status || 500; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: message(e) }));
  }
});
server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is busy. Try PORT=${PORT + 1} node server.mjs` : message(e)); process.exit(1); });
// Short keep-alive: idle sockets pile up on a small instance and keep shutdown waiting.
server.keepAliveTimeout = 5000;
server.headersTimeout = 10000;
// Keep serving through unexpected errors — a crash means a 502 window for every visitor. Only bail out
// after repeated fatals so Render can restart us on a clean slate.
let fatalCount = 0;
const onFatal = label => err => { console.error(`[${label}]`, err?.stack || err); if (++fatalCount >= 3) { console.error('Too many fatal errors, exiting so Render restarts the service.'); process.exit(1); } };
process.on('uncaughtException', onFatal('uncaughtException'));
process.on('unhandledRejection', onFatal('unhandledRejection'));
// Watchdog: if the listener dies, exit so Render restarts the service instead of serving dead sockets.
setInterval(() => { if (!server.listening) { console.error('HTTP server stopped listening, exiting for a clean restart.'); process.exit(1); } }, 15000).unref();
await save();
server.listen(PORT, PRODUCTION ? '0.0.0.0' : '127.0.0.1', () => console.log(`Account Desk: ${PRODUCTION ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : `http://127.0.0.1:${server.address().port}`} (ready in ${Date.now() - startedAt}ms)`));
// One account per two minutes, round-robin: every account is refreshed about every ten minutes
// (the UI marks snapshots stale after 15 minutes) without one big CPU spike that freezes the site.
let refreshCursor = 0;
const timer = setInterval(() => {
  const accounts = state.accounts.filter(a => a.source === 'codex');
  if (!accounts.length) return;
  const account = accounts[refreshCursor++ % accounts.length];
  enqueue(() => syncAccount(account));
}, 2 * 60 * 1000);
refreshAll();
async function shutdown() {
  clearInterval(timer);
  // Always exit 0: Render reports a non-zero exit as a server failure and emails the owner.
  const hardExit = setTimeout(() => process.exit(0), 8000);
  hardExit.unref();
  for (const p of clients.values()) p.then(c => c.stop()).catch(() => {});
  await writes.catch(() => {});
  await resetMongo();
  try { server.close(); server.closeIdleConnections?.(); } catch {}
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
