"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Isolate HOME *before* loading dist modules: token and oauth paths are computed at import.
// Previous versions of this file touched the real ~/.config; nothing here may do that.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ccmcp-home-"));
process.env.HOME = HOME;
process.env.GOOGLE_CLIENT_ID = "test-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";

const { loadConfig } = require("../dist/config.js");
const { ContextStore } = require("../dist/store.js");
const g = require("../dist/google.js");
const { tempStore } = require("./helpers");

const TOKEN = path.join(HOME, ".config", "common-context-mcp", "google-tokens.json");
const realFetch = global.fetch;
const realSyncId = process.env.CONTEXT_MCP_SYNC_ID;

function login() {
  g.saveTokens({ access_token: "test-access", refresh_token: "test-refresh", expiry_date: Date.now() + 3600_000 });
}

function makeStore() {
  const { dir, file } = tempStore();
  return { dir, store: new ContextStore(loadConfig({ CONTEXT_MCP_FILE: file })) };
}

/** In-memory Google Drive stub answering the exact calls google.ts makes. */
function fakeDrive() {
  const files = new Map(); // name -> { id, name, modifiedTime, content }
  let seq = 0;
  const stamp = () => new Date(Date.now() + ++seq).toISOString(); // strictly increasing
  const ok = body => ({ ok: true, status: 200, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
  const fail = (status, text) => ({ ok: false, status, json: async () => ({}), text: async () => text });

  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const method = (opts.method || "GET").toUpperCase();
    if (u.hostname !== "www.googleapis.com") throw new Error(`unexpected host: ${u.hostname}`);
    if (method === "GET" && u.pathname === "/drive/v3/files" && !u.searchParams.has("alt")) {
      const q = u.searchParams.get("q") || "";
      const m = /name='((?:[^'\\]|\\.)*)'/.exec(q);
      const want = m ? m[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\") : null;
      const found = [...files.values()].filter(f => f.name === want).map(({ id, name, modifiedTime }) => ({ id, name, modifiedTime }));
      return ok({ files: found });
    }
    if (method === "GET" && u.pathname.startsWith("/drive/v3/files/") && u.searchParams.get("alt") === "media") {
      const id = u.pathname.split("/").pop();
      const f = [...files.values()].find(x => x.id === id);
      if (!f) return fail(404, "not found");
      return ok(f.content);
    }
    if ((method === "POST" || method === "PATCH") && u.pathname.startsWith("/upload/drive/v3/files")) {
      const body = String(opts.body || "");
      const nameMatch = /"name"\s*:\s*"([^"]+)"/.exec(body);
      if (!nameMatch) return fail(400, "no name in multipart body");
      const parts = body.split("\r\n\r\n");
      const tail = parts[parts.length - 1];
      const content = tail.slice(0, tail.lastIndexOf("\r\n--"));
      if (method === "POST") {
        const id = `id-${files.size + 1}`;
        files.set(nameMatch[1], { id, name: nameMatch[1], modifiedTime: stamp(), content });
        const f = files.get(nameMatch[1]);
        return ok({ id: f.id, name: f.name, modifiedTime: f.modifiedTime });
      }
      const id = u.pathname.split("/").pop();
      const f = [...files.values()].find(x => x.id === id);
      if (!f) return fail(404, "not found");
      f.content = content;
      f.modifiedTime = stamp();
      return ok({ id: f.id, name: f.name, modifiedTime: f.modifiedTime });
    }
    throw new Error(`unexpected Drive call: ${method} ${url}`);
  };

  return {
    fetch,
    get: name => files.get(name),
    names: () => [...files.keys()],
    put: (name, content) => files.set(name, { id: `id-${files.size + 1}`, name, modifiedTime: stamp(), content }),
  };
}

test.afterEach(async () => {
  // Flush queued uploads while the stub is still installed, so nothing leaks into a later test.
  try {
    await g.flushPendingPush();
  } catch {}
  global.fetch = realFetch;
  if (realSyncId === undefined) delete process.env.CONTEXT_MCP_SYNC_ID;
  else process.env.CONTEXT_MCP_SYNC_ID = realSyncId;
  g.clearTokens();
});

test("HOME isolation: token file lives under the temp home", () => {
  login();
  assert.ok(fs.existsSync(TOKEN), "tokens written to temp HOME");
  assert.ok(TOKEN.startsWith(HOME));
});

test("loadOAuthConfig reads env credentials", () => {
  const cfg = g.loadOAuthConfig();
  assert.equal(cfg.clientId, "test-client-id");
  assert.equal(cfg.clientSecret, "test-client-secret");
});

test("loadTokens/saveTokens roundtrip", () => {
  login();
  assert.equal(g.loadTokens().access_token, "test-access");
  assert.equal(g.isLoggedIn(), true);
});

test("loadTokens rejects malformed token files instead of trusting them", () => {
  fs.mkdirSync(path.dirname(TOKEN), { recursive: true });
  for (const bad of ['["not","an","object"]', '{"access_token":123}', '{"access_token":""}', '{"expiry_date":1}', "not json"]) {
    fs.writeFileSync(TOKEN, bad);
    assert.equal(g.loadTokens(), null, bad);
    assert.equal(g.isLoggedIn(), false, bad);
  }
});

test("syncStatus never crashes on a token file without an expiry", () => {
  fs.mkdirSync(path.dirname(TOKEN), { recursive: true });
  fs.writeFileSync(TOKEN, JSON.stringify({ access_token: "x" }));
  const out = g.syncStatus();
  assert.match(out, /Logged in: yes/);
  assert.match(out, /Token expires: unknown/);
});

test("logout revokes the token with Google, then clears the file", async () => {
  login();
  let revoked = null;
  global.fetch = async (url, opts) => {
    revoked = { url: String(url), method: (opts && opts.method) || "GET" };
    return { ok: true, status: 200 };
  };
  try {
    assert.equal(await g.logout(), "revoked");
    assert.match(revoked.url, /oauth2\.googleapis\.com\/revoke/);
    assert.match(revoked.url, /test-access/);
    assert.equal(fs.existsSync(TOKEN), false, "token file removed");
    assert.equal(g.isLoggedIn(), false);
  } finally {
    global.fetch = realFetch;
  }
});

test("logout still clears everything when Google is unreachable", async () => {
  login();
  global.fetch = async () => { throw new Error("offline"); };
  try {
    assert.equal(await g.logout(), "local-only");
    assert.equal(fs.existsSync(TOKEN), false, "token file removed");
  } finally {
    global.fetch = realFetch;
  }
});

test("logout with nothing stored succeeds quietly", async () => {
  let calls = 0;
  global.fetch = async () => { calls++; return { ok: true, status: 200 }; };
  try {
    assert.equal(await g.logout(), "local-only");
    assert.equal(calls, 0, "no revoke without a token");
  } finally {
    global.fetch = realFetch;
  }
});

test("login code exchange rejects garbage instead of saving it", async () => {
  const cfg = { clientId: "id", clientSecret: "secret" };
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ no_token: true }), text: async () => "" });
  try {
    await assert.rejects(g.exchangeCode(cfg, "code", "http://127.0.0.1:9/callback"), /token exchange failed/);
    assert.equal(fs.existsSync(TOKEN), false, "nothing saved");
  } finally {
    global.fetch = realFetch;
  }
  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_grant" }), text: async () => "" });
  try {
    await assert.rejects(g.exchangeCode(cfg, "code", "http://127.0.0.1:9/callback"), /invalid_grant/);
  } finally {
    global.fetch = realFetch;
  }
});

test("token refresh fails cleanly on an unreadable response", async () => {
  g.saveTokens({ access_token: "stale", refresh_token: "r", expiry_date: Date.now() - 1000 });
  global.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad json"); }, text: async () => "" });
  try {
    await assert.rejects(g.getAccessToken(), /token refresh failed/);
  } finally {
    global.fetch = realFetch;
  }
});

test("a denied browser login says so plainly", () => {
  assert.throws(() => g.parseAuthCallback("/callback?error=access_denied&state=s", "s"), /denied in the browser.*access_denied/);
});

test("pullIfNewer and pushNow no-op when not logged in", async () => {
  const { dir, store } = makeStore();
  try {
    const pull = await g.pullIfNewer(store);
    assert.equal(pull.pulled, false);
    assert.match(pull.reason, /not logged in/);
    store.write(() => {});
    const push = await g.pushNow(store);
    assert.equal(push.pushed, false);
    assert.match(push.reason, /not logged in/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("remoteNameFor: explicit sync id wins and is slugged", () => {
  process.env.CONTEXT_MCP_SYNC_ID = "My Cool Project!";
  assert.equal(g.remoteNameFor("/tmp/x/store.json"), "common-context--my-cool-project.json");
});

test("remoteNameFor: git origin gives a stable cross-machine name", () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "ccmcp-proj-"));
  try {
    fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
    fs.writeFileSync(
      path.join(proj, ".git", "config"),
      '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = git@github.com:acme/widgets.git\n'
    );
    const sub = path.join(proj, "packages", "app");
    fs.mkdirSync(sub, { recursive: true });
    assert.equal(g.remoteNameFor(path.join(sub, "common-context.json")), "common-context--github-com-acme-widgets.json");
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test("remoteNameFor: without git, folder hash keeps projects apart", () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), "ccmcp-a-"));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), "ccmcp-b-"));
  try {
    const na = g.remoteNameFor(path.join(a, "store.json"));
    const nb = g.remoteNameFor(path.join(b, "store.json"));
    assert.match(na, /^common-context--.+-[0-9a-f]{12}\.json$/);
    assert.notEqual(na, nb);
    assert.equal(g.remoteNameFor(path.join(a, "store.json")), na, "deterministic");
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test("pull merges remote entries into local instead of replacing", async () => {
  process.env.CONTEXT_MCP_SYNC_ID = "merge-test";
  const drive = fakeDrive();
  global.fetch = drive.fetch;
  login();
  const { dir, store } = makeStore();
  try {
    store.write(d => {
      d.contexts.local = { value: "mine", tags: [], agent: "a", updated: "2026-01-01T00:00:00.000Z", history: [] };
    });
    drive.put("common-context--merge-test.json", JSON.stringify({
      version: 2, created: "2026-01-01T00:00:00.000Z",
      contexts: { remote: { value: "theirs", tags: [], agent: "b", updated: "2026-01-02T00:00:00.000Z", history: [] } },
      sessions: [], failures: [], claims: {}, broadcasts: [], patterns: { works: [], fails: [] },
    }));
    const r = await g.pullIfNewer(store);
    assert.equal(r.pulled, true);
    assert.match(r.reason, /merged/);
    const keys = store.read(d => Object.keys(d.contexts).sort());
    assert.deepEqual(keys, ["local", "remote"], "both sides survive the merge");
    const again = await g.pullIfNewer(store);
    assert.equal(again.pulled, false, "second pull is a no-op");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("push uploads once, then skips while nothing changed", async () => {
  process.env.CONTEXT_MCP_SYNC_ID = "push-test";
  const drive = fakeDrive();
  global.fetch = drive.fetch;
  login();
  const { dir, store } = makeStore();
  try {
    store.write(d => {
      d.contexts.k = { value: "v", tags: [], agent: "a", updated: new Date().toISOString(), history: [] };
    });
    const first = await g.pushNow(store);
    assert.equal(first.pushed, true);
    assert.match(first.reason, /created/);
    assert.ok(drive.get("common-context--push-test.json"), "remote file created");
    const second = await g.pushNow(store);
    assert.equal(second.pushed, false);
    assert.match(second.reason, /no local changes/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("two machines converge: push merges a changed remote instead of clobbering it", async () => {
  process.env.CONTEXT_MCP_SYNC_ID = "converge-test";
  const drive = fakeDrive();
  global.fetch = drive.fetch;
  login();
  const m1 = makeStore();
  const m2 = makeStore();
  try {
    m1.store.write(d => {
      d.contexts.fromM1 = { value: "1", tags: [], agent: "m1", updated: "2026-01-01T00:00:00.000Z", history: [] };
    });
    assert.equal((await g.pushNow(m1.store)).pushed, true);
    m2.store.write(d => {
      d.contexts.fromM2 = { value: "2", tags: [], agent: "m2", updated: "2026-01-02T00:00:00.000Z", history: [] };
    });
    const push = await g.pushNow(m2.store);
    assert.equal(push.pushed, true);
    assert.match(push.reason, /merged remote first/);
    const remote = JSON.parse(drive.get("common-context--converge-test.json").content);
    assert.deepEqual(Object.keys(remote.contexts).sort(), ["fromM1", "fromM2"], "remote holds both machines' entries");
    const pull = await g.pullIfNewer(m1.store);
    assert.equal(pull.pulled, true);
    assert.deepEqual(m1.store.read(d => Object.keys(d.contexts).sort()), ["fromM1", "fromM2"]);
    // Each side uploads the union once, then everything is quiet: no redundant pushes.
    assert.equal((await g.pushNow(m1.store)).pushed, true);
    assert.equal((await g.pushNow(m1.store)).pushed, false);
    assert.equal((await g.pushNow(m2.store)).pushed, false);
  } finally {
    fs.rmSync(m1.dir, { recursive: true, force: true });
    fs.rmSync(m2.dir, { recursive: true, force: true });
  }
});

test("different projects sync to different remote files", async () => {
  const drive = fakeDrive();
  global.fetch = drive.fetch;
  login();
  const a = makeStore();
  const b = makeStore();
  try {
    process.env.CONTEXT_MCP_SYNC_ID = "project-a";
    a.store.write(() => {});
    assert.equal((await g.pushNow(a.store)).pushed, true);
    process.env.CONTEXT_MCP_SYNC_ID = "project-b";
    b.store.write(() => {});
    assert.equal((await g.pushNow(b.store)).pushed, true);
    assert.deepEqual(drive.names().sort(), ["common-context--project-a.json", "common-context--project-b.json"]);
  } finally {
    fs.rmSync(a.dir, { recursive: true, force: true });
    fs.rmSync(b.dir, { recursive: true, force: true });
  }
});

test("an unreadable remote is backed up locally, then overwritten by push", async () => {
  process.env.CONTEXT_MCP_SYNC_ID = "garbage-test";
  const drive = fakeDrive();
  global.fetch = drive.fetch;
  login();
  const { dir, store } = makeStore();
  try {
    store.write(() => {});
    drive.put("common-context--garbage-test.json", "{not json at all");
    const pull = await g.pullIfNewer(store);
    assert.equal(pull.pulled, false);
    assert.match(pull.reason, /not valid JSON/);
    const backups = fs.readdirSync(dir).filter(f => f.includes(".remote-backup-"));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), "utf-8"), "{not json at all");
    const push = await g.pushNow(store);
    assert.equal(push.pushed, true, "push recovers by overwriting garbage");
    assert.doesNotThrow(() => JSON.parse(drive.get("common-context--garbage-test.json").content));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a newer-schema remote is never overwritten", async () => {
  process.env.CONTEXT_MCP_SYNC_ID = "schema-test";
  const drive = fakeDrive();
  global.fetch = drive.fetch;
  login();
  const { dir, store } = makeStore();
  try {
    store.write(() => {});
    const future = JSON.stringify({ version: 999, contexts: {} });
    drive.put("common-context--schema-test.json", future);
    const pull = await g.pullIfNewer(store);
    assert.equal(pull.pulled, false);
    assert.match(pull.reason, /newer than this server/);
    const push = await g.pushNow(store);
    assert.equal(push.pushed, false, "push must not downgrade the remote");
    assert.equal(drive.get("common-context--schema-test.json").content, future);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writes upload to the cloud while logged in", async () => {
  process.env.CONTEXT_MCP_SYNC_ID = "continuous-test";
  const drive = fakeDrive();
  global.fetch = drive.fetch;
  login();
  const { dir, store } = makeStore();
  try {
    store.write(d => {
      d.contexts.k = { value: "v", tags: [], agent: "a", updated: new Date().toISOString(), history: [] };
    });
    const deadline = Date.now() + 5000;
    while (!drive.get("common-context--continuous-test.json") && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(drive.get("common-context--continuous-test.json"), "the write reached the cloud");
    const calls = [];
    global.fetch = (...a) => { calls.push(a); return drive.fetch(...a); };
    await g.flushPendingPush();
    assert.equal(calls.length, 0, "a delivered upload is not retried");
  } finally {
    global.fetch = realFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writes stay local when logged out", async () => {
  process.env.CONTEXT_MCP_SYNC_ID = "logged-out-test";
  const drive = fakeDrive();
  let calls = 0;
  global.fetch = (...a) => { calls++; return drive.fetch(...a); };
  const { dir, store } = makeStore();
  try {
    store.write(d => {
      d.contexts.k = { value: "v", tags: [], agent: "a", updated: new Date().toISOString(), history: [] };
    });
    await g.flushPendingPush();
    await new Promise(r => setTimeout(r, 900));
    assert.equal(calls, 0, "no network without login");
    assert.equal(drive.get("common-context--logged-out-test.json"), undefined);
  } finally {
    global.fetch = realFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed push stays queued until it is delivered", async () => {
  process.env.CONTEXT_MCP_SYNC_ID = "retry-test-2";
  const drive = fakeDrive();
  login();
  const { dir, store } = makeStore();
  try {
    store.write(() => {});
    global.fetch = async () => { throw new Error("offline"); };
    g.markNeedsPush(store);
    const failed = await g.pushNow(store);
    assert.equal(failed.pushed, false);
    global.fetch = drive.fetch;
    await g.flushPendingPush();
    assert.ok(drive.get("common-context--retry-test-2.json"), "retry delivered the queued upload");
  } finally {
    global.fetch = realFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("syncAfterLogin stores the local copy in the cloud", async () => {
  process.env.CONTEXT_MCP_SYNC_ID = "login-upload-test";
  const drive = fakeDrive();
  global.fetch = drive.fetch;
  login();
  const { dir, store } = makeStore();
  try {
    store.write(d => {
      d.contexts.k = { value: "v", tags: [], agent: "a", updated: new Date().toISOString(), history: [] };
    });
    const { push } = await g.syncAfterLogin(store);
    assert.equal(push.pushed, true, push.reason);
    assert.match(drive.get("common-context--login-upload-test.json").content, /"k"/);
  } finally {
    global.fetch = realFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("end to end in-process: tool writes reach the cloud while logged in", async () => {
  process.env.CONTEXT_MCP_SYNC_ID = "tool-push-test";
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
  const { createServer } = require("../dist/server.js");
  const drive = fakeDrive();
  global.fetch = drive.fetch;
  login();
  const { dir, file } = tempStore();
  // Pin via the real env: the server only trusts process.env for pinning, and
  // without it the tools would follow the working directory (this repo!).
  const prevFile = process.env.CONTEXT_MCP_FILE;
  process.env.CONTEXT_MCP_FILE = file;
  const cfg = loadConfig({ CONTEXT_MCP_FILE: file, CONTEXT_MCP_AGENT_ID: "push-agent" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = createServer(cfg);
  await server.connect(serverT);
  const client = new Client({ name: "push-test", version: "0.0.0" });
  await client.connect(clientT);
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const NAME = "common-context--tool-push-test.json";
  try {
    await call("load_context");
    await call("save_context", { key: "k", value: "v" });
    const deadline = Date.now() + 5000;
    while (!drive.get(NAME) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    assert.ok(drive.get(NAME), "the tool write reached the cloud");
    assert.match(drive.get(NAME).content, /"k"/);
  } finally {
    global.fetch = realFetch;
    if (prevFile === undefined) delete process.env.CONTEXT_MCP_FILE;
    else process.env.CONTEXT_MCP_FILE = prevFile;
    await client.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("syncStatus reports the project's remote and last sync times", async () => {
  process.env.CONTEXT_MCP_SYNC_ID = "status-test";
  const drive = fakeDrive();
  global.fetch = drive.fetch;
  login();
  const { dir, store } = makeStore();
  try {
    store.write(() => {});
    await g.pushNow(store);
    const s = g.syncStatus(store.file);
    assert.match(s, /OAuth configured: yes/);
    assert.match(s, /Logged in: yes/);
    assert.match(s, /Remote file: common-context--status-test\.json/);
    assert.match(s, /Last push: \d{4}-/);
    assert.match(s, /Last pull: never/);
    assert.deepEqual(g.loadSyncState(store.file).remote, "common-context--status-test.json");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("remoteNameFor: custom store filenames get their own suffix", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ccmcp-n-"));
  try {
    const plain = g.remoteNameFor(path.join(d, "common-context.json"));
    const custom = g.remoteNameFor(path.join(d, "custom.json"));
    assert.notEqual(plain, custom, "two files in one folder must not share a remote");
    assert.match(custom, /custom/);
    assert.match(plain, /^common-context--.+-[0-9a-f]{12}\.json$/);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test("remoteNameFor: ssh URLs with ports match their plain equivalents", () => {
  const mk = url => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "ccmcp-u-"));
    fs.mkdirSync(path.join(d, ".git"), { recursive: true });
    fs.writeFileSync(path.join(d, ".git", "config"), `[remote "origin"]\n\turl = ${url}\n`);
    return d;
  };
  const a = mk("ssh://git@github.com:22/acme/widgets.git");
  const b = mk("https://github.com/acme/widgets.git");
  try {
    assert.equal(
      g.remoteNameFor(path.join(a, "common-context.json")),
      g.remoteNameFor(path.join(b, "common-context.json"))
    );
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test("remoteNameFor: git worktrees resolve the shared origin", () => {
  const main = fs.mkdtempSync(path.join(os.tmpdir(), "ccmv-main-"));
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "ccmv-wt-"));
  try {
    fs.mkdirSync(path.join(main, ".git"), { recursive: true });
    fs.writeFileSync(path.join(main, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/acme/widgets.git\n');
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "wt")}\n`);
    fs.mkdirSync(path.join(main, ".git", "worktrees", "wt"), { recursive: true });
    fs.writeFileSync(path.join(main, ".git", "worktrees", "wt", "config"), '[remote "origin"]\n\turl = https://github.com/acme/widgets.git\n');
    assert.equal(
      g.remoteNameFor(path.join(wt, "common-context.json")),
      "common-context--github-com-acme-widgets.json"
    );
  } finally {
    fs.rmSync(main, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

test("remoteNameFor: distinct junk sync ids do not collapse", () => {
  process.env.CONTEXT_MCP_SYNC_ID = "!!!";
  const a = g.remoteNameFor("/tmp/x/store.json");
  process.env.CONTEXT_MCP_SYNC_ID = "???";
  const b = g.remoteNameFor("/tmp/x/store.json");
  assert.notEqual(a, b);
  assert.match(a, /^common-context--shared-[0-9a-f]{6}\.json$/);
});

test("timedFetch aborts a hanging server", async () => {
  const http = require("node:http");
  const server = http.createServer(() => {}); // accepts, never responds
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  try {
    const t0 = Date.now();
    await assert.rejects(g.timedFetch(`http://127.0.0.1:${server.address().port}`, {}, 150));
    assert.ok(Date.now() - t0 < 5000, "aborted near the deadline");
  } finally {
    server.close();
  }
});

test("drive calls refresh once and retry on 401", async () => {
  process.env.CONTEXT_MCP_SYNC_ID = "retry-test";
  login();
  let tokenPosts = 0;
  let listCalls = 0;
  global.fetch = async url => {
    const u = new URL(url);
    if (u.hostname === "oauth2.googleapis.com") {
      tokenPosts++;
      return { ok: true, status: 200, json: async () => ({ access_token: "fresh", expires_in: 3600 }), text: async () => "" };
    }
    if (u.pathname.startsWith("/upload/")) {
      return { ok: true, status: 200, json: async () => ({ id: "id-1", name: "n", modifiedTime: new Date().toISOString() }), text: async () => "" };
    }
    listCalls++;
    if (listCalls === 1) return { ok: false, status: 401, json: async () => ({}), text: async () => "unauthorized" };
    return { ok: true, status: 200, json: async () => ({ files: [] }), text: async () => "" };
  };
  const { dir, store } = makeStore();
  try {
    store.write(() => {});
    const push = await g.pushNow(store);
    assert.equal(tokenPosts, 1, "one forced refresh");
    assert.equal(listCalls, 2, "list retried after refresh");
    assert.equal(push.pushed, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent expired-token readers trigger a single refresh", async () => {
  login();
  g.saveTokens({ access_token: "stale", refresh_token: "r", expiry_date: Date.now() - 1000 });
  let tokenPosts = 0;
  global.fetch = async () => {
    tokenPosts++;
    await new Promise(r => setTimeout(r, 50));
    return { ok: true, status: 200, json: async () => ({ access_token: `fresh-${tokenPosts}`, expires_in: 3600 }), text: async () => "" };
  };
  try {
    const [a, b, c] = await Promise.all([g.getAccessToken(), g.getAccessToken(), g.getAccessToken()]);
    assert.equal(tokenPosts, 1, "refresh serialized across callers");
    assert.equal(a, b);
    assert.equal(b, c);
  } finally {
    global.fetch = realFetch;
  }
});

test("findDriveFile picks the newest of same-named duplicates", async () => {
  login();
  global.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ files: [
      { id: "old", name: "x", modifiedTime: "2026-01-01T00:00:00.000Z" },
      { id: "new", name: "x", modifiedTime: "2026-02-01T00:00:00.000Z" },
    ] }),
    text: async () => "",
  });
  try {
    const found = await g.findDriveFile("x");
    assert.equal(found.id, "new");
  } finally {
    global.fetch = realFetch;
  }
});

test("listSyncedRemotes returns newest first", async () => {
  login();
  global.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ files: [
      { id: "a", name: "common-context--b.json", modifiedTime: "2026-01-01T00:00:00.000Z" },
      { id: "b", name: "common-context.json", modifiedTime: "2026-03-01T00:00:00.000Z" },
      { id: "c", name: "common-context--a.json", modifiedTime: "2026-02-01T00:00:00.000Z" },
    ] }),
    text: async () => "",
  });
  try {
    const names = (await g.listSyncedRemotes()).map(f => f.name);
    assert.deepEqual(names, ["common-context.json", "common-context--a.json", "common-context--b.json"]);
  } finally {
    global.fetch = realFetch;
  }
});

test("unreadable-remote backups are pruned to five", async () => {
  process.env.CONTEXT_MCP_SYNC_ID = "prune-test";
  const drive = fakeDrive();
  global.fetch = drive.fetch;
  login();
  const { dir, store } = makeStore();
  try {
    store.write(() => {});
    for (let i = 0; i < 7; i++) fs.writeFileSync(`${store.file}.remote-backup-${i}`, "junk");
    drive.put("common-context--prune-test.json", "{junk");
    await g.pullIfNewer(store);
    const left = fs.readdirSync(dir).filter(f => f.includes(".remote-backup-"));
    assert.equal(left.length, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("OAuth helpers: state round-trips, mismatch and errors rejected", () => {
  const cfg = { clientId: "id", clientSecret: "secret" };
  const url = g.buildAuthUrl(cfg, "http://127.0.0.1:9/callback", "s3cr3t");
  assert.match(url, /state=s3cr3t/);
  assert.match(url, /scope=.*drive/);
  assert.equal(g.parseAuthCallback("/callback?code=abc&state=s3cr3t", "s3cr3t"), "abc");
  assert.throws(() => g.parseAuthCallback("/callback?code=abc&state=nope", "s3cr3t"), /state mismatch/);
  assert.throws(() => g.parseAuthCallback("/callback?error=denied&state=s3cr3t", "s3cr3t"), /denied/);
  assert.throws(() => g.parseAuthCallback("/callback?state=s3cr3t", "s3cr3t"), /missing code/);
  assert.equal(g.escHtml('<b>&"'), "&lt;b&gt;&amp;&quot;");
});

test("readCappedText refuses oversized bodies", async () => {
  const reader = chunks => {
    let i = 0;
    return { read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }), cancel: async () => {} };
  };
  const res = chunks => ({ headers: { get: () => null }, body: { getReader: () => reader(chunks) }, text: async () => { throw new Error("must stream"); } });
  const small = await g.readCappedText(res([new Uint8Array([104, 105])]), 16);
  assert.equal(small, "hi");
  await assert.rejects(g.readCappedText(res([new Uint8Array(10), new Uint8Array(10)]), 16), /too large/);
  await assert.rejects(
    g.readCappedText({ headers: { get: () => String(10 ** 9) }, body: null, text: async () => "" }),
    /too large/
  );
});

test("openCommand uses a shell builtin shim on Windows", () => {
  assert.deepEqual(g.openCommand("darwin"), { cmd: "open", args: [] });
  assert.deepEqual(g.openCommand("linux"), { cmd: "xdg-open", args: [] });
  assert.deepEqual(g.openCommand("win32"), { cmd: "cmd", args: ["/c", "start", ""] });
});

test("loadSyncState tolerates a missing or corrupt sidecar", () => {
  const { dir, store } = makeStore();
  try {
    assert.deepEqual(g.loadSyncState(store.file), { remote: null, remoteModifiedTime: null, localHash: null, lastPull: null, lastPush: null });
    fs.writeFileSync(`${store.file}.sync.json`, "{corrupt");
    assert.deepEqual(g.loadSyncState(store.file).remote, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
