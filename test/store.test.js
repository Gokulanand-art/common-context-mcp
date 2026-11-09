"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { tempStore } = require("./helpers");
const { loadConfig } = require("../dist/config.js");
const { ContextStore, SCHEMA_VERSION, StoreError, appendArchive, capHistory, dropArchived, isReservedKey, readArchiveEntries, splitArchive } = require("../dist/store.js");

const WORKER = path.join(__dirname, "worker.js");

test("concurrent writers from separate processes lose no updates", async () => {
  const { dir, file } = tempStore();
  const procs = 6;
  const perProc = 40;
  await Promise.all(
    Array.from({ length: procs }, () =>
      new Promise((resolve, reject) => {
        const c = spawn(process.execPath, [WORKER, file, String(perProc)], { stdio: "inherit" });
        c.on("exit", code => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))));
      })
    )
  );
  const data = JSON.parse(fs.readFileSync(file, "utf-8"));
  assert.equal(Number(data.contexts.counter.value), procs * perProc);
  assert.equal(fs.existsSync(`${file}.lock`), false, "lock must be released");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a corrupt store is copied aside, not silently destroyed", () => {
  const { dir, file } = tempStore();
  fs.writeFileSync(file, "{not json");
  const store = new ContextStore(loadConfig({ CONTEXT_MCP_FILE: file }));
  const n = store.read(d => Object.keys(d.contexts).length);
  assert.equal(n, 0);
  const backups = fs.readdirSync(dir).filter(f => f.includes(".corrupt-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), "utf-8"), "{not json");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a store from a newer schema is refused, never overwritten", () => {
  const { dir, file } = tempStore();
  const future = { version: SCHEMA_VERSION + 1, contexts: {} };
  fs.writeFileSync(file, JSON.stringify(future));
  const store = new ContextStore(loadConfig({ CONTEXT_MCP_FILE: file }));
  assert.throws(() => store.write(() => 1), StoreError);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), future);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a v1 store is upgraded in place on write, keeping its data", () => {
  const { dir, file } = tempStore();
  const v1 = {
    version: 1,
    created: "2026-10-01T00:00:00.000Z",
    contexts: { k: { value: "v", tags: ["t"], agent: "a", updated: "2026-10-01T00:00:00.000Z" } },
    sessions: [{ id: "session-1", title: "old", status: "completed", accomplished: "", learned: "", decisions: "", next_steps: "", checkpoint: "", agent: "a", timestamp: "2026-10-01T00:00:00.000Z" }],
    failures: [], claims: {}, broadcasts: [], patterns: { works: [], fails: [] },
  };
  fs.writeFileSync(file, JSON.stringify(v1));
  const store = new ContextStore(loadConfig({ CONTEXT_MCP_FILE: file }));
  store.write(() => {});
  const out = JSON.parse(fs.readFileSync(file, "utf-8"));
  assert.equal(out.version, SCHEMA_VERSION);
  assert.equal(out.contexts.k.value, "v");
  assert.deepEqual(out.contexts.k.history, []);
  assert.ok(out.sessions[0].heartbeat, "heartbeat backfilled");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("release never removes a lock another process has taken over", () => {
  const { dir, file } = tempStore();
  const lock = `${file}.lock`;
  const store = new ContextStore(loadConfig({ CONTEXT_MCP_FILE: file }));

  // We hold the lock...
  store.acquire("mine");
  assert.equal(fs.existsSync(lock), true);
  // ...another process breaks it as stale and takes over...
  fs.writeFileSync(lock, "thief");
  // ...so our release must leave their lock alone.
  store.release("mine");
  assert.equal(fs.existsSync(lock), true, "foreign lock must survive our release");
  assert.throws(() => store.assertOwner("mine"), StoreError, "lost ownership must be detected before writing");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("release removes the lock while we still own it", () => {
  const { dir, file } = tempStore();
  const lock = `${file}.lock`;
  const store = new ContextStore(loadConfig({ CONTEXT_MCP_FILE: file }));
  store.acquire("mine");
  store.release("mine");
  assert.equal(fs.existsSync(lock), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a stale lock from a crashed process is recovered", () => {
  const { dir, file } = tempStore();
  const lock = `${file}.lock`;
  fs.writeFileSync(lock, "999999\n");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  const store = new ContextStore(loadConfig({ CONTEXT_MCP_FILE: file }));
  store.write(d => {
    d.contexts.after = { value: "ok", tags: [], agent: "x", updated: new Date().toISOString(), history: [] };
  });
  assert.equal(fs.existsSync(lock), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("reserved keys are recognized and never load from disk", () => {
  assert.equal(isReservedKey("__proto__"), true);
  assert.equal(isReservedKey("constructor"), true);
  assert.equal(isReservedKey("prototype"), true);
  assert.equal(isReservedKey("progress"), false);
  const { dir, file } = tempStore();
  // Note: built as a string, since a __proto__ object-literal key would not serialize.
  fs.writeFileSync(file, `{"version":2,"created":"t","contexts":{"__proto__":{"value":"x","tags":[],"agent":"a","updated":"t","history":[]}},"sessions":[],"failures":[],"claims":{"__proto__":{"agent":"a","since":"t","expires":"t"}},"broadcasts":[],"patterns":{"works":[],"fails":[]}}`);
  assert.ok(fs.readFileSync(file, "utf-8").includes("__proto__"), "fixture really contains the key");
  const store = new ContextStore(loadConfig({ CONTEXT_MCP_FILE: file }));
  const keys = store.read(d => [Object.keys(d.contexts), Object.keys(d.claims)]);
  assert.deepEqual(keys, [[], []]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("context history is capped, oldest first", () => {
  const hist = Array.from({ length: 60 }, (_, i) => ({ value: `v${i}`, agent: "a", updated: "t" }));
  const capped = capHistory(hist);
  assert.equal(capped.length, 50);
  assert.equal(capped[0].value, "v10");
  assert.equal(capped[49].value, "v59");
  assert.equal(capHistory([{ value: "x" }]).length, 1);
});

test("splitArchive moves old broadcasts too", () => {
  const { dir, file } = tempStore();
  const store = new ContextStore(loadConfig({ CONTEXT_MCP_FILE: file }));
  store.write(d => {
    for (let i = 0; i < 205; i++) d.broadcasts.push({ message: `m${i}`, agent: "a", timestamp: new Date().toISOString() });
  });
  const moved = store.write(d => splitArchive(d, { keepSessions: 100, days: 30, keepId: null, now: Date.now() }));
  assert.equal(moved.broadcasts.length, 5);
  assert.equal(store.read(d => d.broadcasts.length), 200);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("archived sessions stay archived through merge, unless changed", () => {
  const { dir, file } = tempStore();
  const store = new ContextStore(loadConfig({ CONTEXT_MCP_FILE: file }));
  const sess = { id: "session-9", title: "t", status: "completed", accomplished: "a", learned: "", decisions: "", next_steps: "", checkpoint: "", agent: "m", timestamp: "2026-01-01T00:00:00.000Z", heartbeat: "2026-01-01T00:00:00.000Z", ended_at: "2026-01-01T00:00:00.000Z" };
  store.write(d => { d.created = "2026-01-01T00:00:00.000Z"; });
  appendArchive(file, [sess], []);
  // Stale copy from another machine: dropped.
  assert.equal(store.mergeRemote({ version: 2, created: sess.timestamp, contexts: {}, sessions: [JSON.parse(JSON.stringify(sess))], failures: [], claims: {}, broadcasts: [], patterns: { works: [], fails: [] } }), false);
  assert.deepEqual(store.read(d => d.sessions.map(s => s.id)), []);
  // Resumed copy (changed heartbeat): kept.
  const resumed = { ...sess, status: "checkpointed", heartbeat: "2026-05-01T00:00:00.000Z" };
  assert.equal(store.mergeRemote({ version: 2, created: sess.timestamp, contexts: {}, sessions: [resumed], failures: [], claims: {}, broadcasts: [], patterns: { works: [], fails: [] } }), true);
  assert.deepEqual(store.read(d => d.sessions.map(s => s.id)), ["session-9"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("appendArchive skips items already archived", () => {
  const { dir, file } = tempStore();
  const sess = { id: "session-1", title: "t", status: "completed", accomplished: "", learned: "", decisions: "", next_steps: "", checkpoint: "", agent: "a", timestamp: "t", heartbeat: "t", ended_at: "t" };
  appendArchive(file, [sess], []);
  appendArchive(file, [sess], []);
  const lines = fs.readFileSync(`${file}.archive.jsonl`, "utf-8").trim().split("\n");
  assert.equal(lines.length, 1, "no duplicate archive lines");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readArchiveEntries returns newest first and skips corrupt lines", () => {
  const { dir, file } = tempStore();
  fs.writeFileSync(`${file}.archive.jsonl`,
    "{junk\n" +
    JSON.stringify({ kind: "session", archived: "t", item: { id: "session-1", title: "old" } }) + "\n" +
    JSON.stringify({ kind: "session", archived: "t", item: { id: "session-2", title: "new" } }) + "\n");
  const entries = readArchiveEntries(file);
  assert.deepEqual(entries.sessions.map(s => s.id), ["session-2", "session-1"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("dropArchived is a no-op without an archive file", () => {
  const { dir, file } = tempStore();
  const d = { sessions: [{ id: "session-1" }], failures: [], broadcasts: [] };
  dropArchived(file, d);
  assert.equal(d.sessions.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("stale write tmp files are swept, fresh ones kept", () => {
  const { dir, file } = tempStore();
  const stale = `${file}.111.abc.tmp`;
  const fresh = `${file}.222.def.tmp`;
  fs.writeFileSync(stale, "x");
  fs.writeFileSync(fresh, "x");
  const old = new Date(Date.now() - 2 * 3600_000);
  fs.utimesSync(stale, old, old);
  const store = new ContextStore(loadConfig({ CONTEXT_MCP_FILE: file }));
  store.write(() => {});
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(fresh), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("corrupt backups are pruned to five", () => {
  const { dir, file } = tempStore();
  for (let i = 0; i < 7; i++) fs.writeFileSync(`${file}.corrupt-${i}`, "junk");
  fs.writeFileSync(file, "{not json");
  const store = new ContextStore(loadConfig({ CONTEXT_MCP_FILE: file }));
  store.read(() => {});
  const left = fs.readdirSync(dir).filter(f => f.includes(".corrupt-"));
  assert.equal(left.length, 5);
  fs.rmSync(dir, { recursive: true, force: true });
});
