"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { tempStore } = require("./helpers");
const { loadConfig } = require("../dist/config.js");
const { ContextStore, SCHEMA_VERSION, StoreError } = require("../dist/store.js");

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
