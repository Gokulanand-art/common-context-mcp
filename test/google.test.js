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
  // Flush debounced pushes while the stub is still installed, so no timer fires into a later test.
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
    assert.equal(g.remoteNameFor(path.join(sub, "store.json")), "common-context--github-com-acme-widgets.json");
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

test("writes push automatically after the debounce", async () => {
  process.env.CONTEXT_MCP_SYNC_ID = "debounce-test";
  const drive = fakeDrive();
  global.fetch = drive.fetch;
  login();
  const { dir, store } = makeStore();
  try {
    store.write(d => {
      d.contexts.k = { value: "v", tags: [], agent: "a", updated: new Date().toISOString(), history: [] };
    });
    await new Promise(r => setTimeout(r, 900));
    assert.ok(drive.get("common-context--debounce-test.json"), "debounced push uploaded the store");
  } finally {
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
