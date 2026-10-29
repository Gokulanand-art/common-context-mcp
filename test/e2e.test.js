"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { tempStore } = require("./helpers");

const SERVER = path.join(__dirname, "..", "dist", "index.js");

async function connect(file, agentId, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, CONTEXT_MCP_FILE: file, CONTEXT_MCP_AGENT_ID: agentId, ...extraEnv },
    stderr: "ignore",
  });
  const client = new Client({ name: "test-" + agentId, version: "0.0.0" });
  await client.connect(transport);
  return client;
}

const call = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { text: r.content.map(c => c.text).join("\n"), isError: !!r.isError };
};

test("exposes all 15 tools with annotations", async () => {
  const { dir, file } = tempStore();
  const c = await connect(file, "a");
  const { tools } = await c.listTools();
  const names = tools.map(t => t.name).sort();
  assert.deepEqual(names, [
    "broadcast", "claim_area", "get_audit_trail", "get_patterns", "handoff", "list_claims",
    "load_context", "record_success", "release_area", "resume_session", "save_context",
    "save_failure", "save_summary", "search_context", "session_status",
  ]);
  const search = tools.find(t => t.name === "search_context");
  assert.equal(search.annotations.readOnlyHint, true);
  await c.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("tools refuse to run before load_context", async () => {
  const { dir, file } = tempStore();
  const c = await connect(file, "a");
  const r = await call(c, "save_context", { key: "k", value: "v" });
  assert.equal(r.isError, true);
  assert.match(r.text, /load_context\(\) first/);
  await c.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("validation rejects oversized and empty input", async () => {
  const { dir, file } = tempStore();
  const c = await connect(file, "a");
  await call(c, "load_context");
  const empty = await c.callTool({ name: "save_context", arguments: { key: "", value: "v" } }).catch(e => e);
  assert.ok(empty instanceof Error || empty.isError, "empty key must be rejected");
  await c.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("search_context is allowed before load_context, writes stay gated", async () => {
  const { dir, file } = tempStore();
  const c = await connect(file, "a");
  // The protocol allows load_context OR search_context as the first call.
  const s = await call(c, "search_context", { query: "anything" });
  assert.equal(s.isError, false, s.text);
  assert.match(s.text, /No results found/);
  // Everything that writes is still gated behind load_context.
  const w = await call(c, "save_context", { key: "k", value: "v" });
  assert.equal(w.isError, true);
  assert.match(w.text, /load_context\(\) first/);
  await c.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("after save_summary, load_context starts the next session", async () => {
  const { dir, file } = tempStore();
  const c = await connect(file, "a");
  await call(c, "load_context");
  const done = await call(c, "save_summary", { title: "First", accomplished: "one" });
  assert.equal(done.isError, false, done.text);

  // A completed session must not be reused: loading opens session-2.
  const loaded = await call(c, "load_context");
  assert.match(loaded.text, /Your session: session-2/);

  // And checkpoints land on the new session, not silently on the completed one.
  const save = await call(c, "save_context", { key: "after", value: "more work" });
  assert.equal(save.isError, false, save.text);
  const data = JSON.parse(fs.readFileSync(file, "utf-8"));
  const s1 = data.sessions.find(x => x.id === "session-1");
  const s2 = data.sessions.find(x => x.id === "session-2");
  assert.equal(s1.status, "completed", "first session stays completed");
  assert.match(s2.checkpoint, /Last saved: after/, "checkpoint lands on the new session");
  await c.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("save, search, failures and patterns round-trip", async () => {
  const { dir, file } = tempStore();
  const c = await connect(file, "a");
  await call(c, "load_context");
  await call(c, "save_context", { key: "db", value: "postgres 16", tags: ["infra"] });
  await call(c, "save_context", { key: "db", value: "postgres 17", tags: ["infra"] });
  await call(c, "save_failure", { approach: "sqlite WAL on NFS", why_failed: "locks corrupt" });
  await call(c, "record_success", { approach: "file lock with O_EXCL" });

  const s = await call(c, "search_context", { query: "POSTGRES" });
  assert.match(s.text, /postgres 17/);
  const f = await call(c, "search_context", { query: "nfs" });
  assert.match(f.text, /sqlite WAL on NFS/);
  const p = await call(c, "get_patterns");
  assert.match(p.text, /file lock with O_EXCL/);
  assert.match(p.text, /sqlite WAL on NFS/);

  const data = JSON.parse(fs.readFileSync(file, "utf-8"));
  assert.equal(data.contexts.db.history.length, 1, "overwrite keeps history");
  assert.equal(data.contexts.db.history[0].value, "postgres 16");
  await c.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("claims block other agents, release frees them", async () => {
  const { dir, file } = tempStore();
  const a = await connect(file, "agent-a");
  const b = await connect(file, "agent-b");
  await call(a, "load_context");
  await call(b, "load_context");

  assert.match((await call(a, "claim_area", { area: "src/x.ts" })).text, /^Claimed/);
  assert.match((await call(b, "claim_area", { area: "src/x.ts" })).text, /already claimed by agent-a/);
  assert.match((await call(b, "release_area", { area: "src/x.ts" })).text, /not claimed by you/);
  assert.match((await call(a, "release_area", { area: "src/x.ts" })).text, /^Released/);
  assert.match((await call(b, "claim_area", { area: "src/x.ts" })).text, /^Claimed/);

  await a.close();
  await b.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a dead session is marked interrupted and can be resumed", async () => {
  const { dir, file } = tempStore();
  const env = { CONTEXT_MCP_STALE_MINUTES: "0.0005" }; // ~30ms heartbeat window
  const a = await connect(file, "agent-a", env);
  await call(a, "load_context");
  await call(a, "save_context", { key: "step", value: "half done" });
  await a.close();
  await new Promise(r => setTimeout(r, 200));

  const b = await connect(file, "agent-b", env);
  const loaded = await call(b, "load_context");
  assert.match(loaded.text, /INTERRUPTED SESSIONS/);
  const id = /\[(session-\d+)\] "In progress\.\.\."[\s\S]*?by agent-a/.exec(loaded.text)?.[1];
  assert.ok(id, "interrupted session id is listed");

  const resumed = await call(b, "resume_session", { session_id: id });
  assert.equal(resumed.isError, false);
  assert.match(resumed.text, /RESUMING SESSION/);
  await b.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a live session of another agent is not interrupted", async () => {
  const { dir, file } = tempStore();
  const a = await connect(file, "agent-a");
  await call(a, "load_context");
  const b = await connect(file, "agent-b");
  const loaded = await call(b, "load_context");
  assert.doesNotMatch(loaded.text, /INTERRUPTED SESSIONS/);
  assert.match(loaded.text, /ACTIVE IN OTHER AGENTS/);
  const r = await call(b, "resume_session", { session_id: "session-1" });
  assert.equal(r.isError, true);
  assert.match(r.text, /still live/);
  await a.close();
  await b.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("save_summary completes the session and later calls do not reopen it", async () => {
  const { dir, file } = tempStore();
  const c = await connect(file, "a");
  await call(c, "load_context");
  const r = await call(c, "save_summary", {
    title: "Build MCP", accomplished: "rewrote store", learned: "locks matter",
    decisions: "O_EXCL lock", next_steps: "ship",
  });
  assert.match(r.text, /Session summary saved/);
  const data = JSON.parse(fs.readFileSync(file, "utf-8"));
  const s = data.sessions.find(x => x.title === "Build MCP");
  assert.equal(s.status, "completed");
  assert.ok(s.ended_at);
  await c.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("load_context output is capped by CONTEXT_MCP_MAX_OUTPUT_CHARS", async () => {
  const { dir, file } = tempStore();
  const c = await connect(file, "a", { CONTEXT_MCP_MAX_OUTPUT_CHARS: "500" });
  await call(c, "load_context");
  for (let i = 0; i < 30; i++) {
    await call(c, "save_context", { key: `k${i}`, value: "x".repeat(200) });
  }
  const r = await call(c, "search_context", { query: "x" });
  assert.match(r.text, /Found \d+ results/);
  const big = await call(c, "get_audit_trail");
  assert.ok(big.text.length <= 700, `audit trail capped, got ${big.text.length}`);
  await c.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("save_summary accepts title and accomplished alone, so a missing field never loses the summary", async () => {
  const { dir, file } = tempStore();
  const c = await connect(file, "a");
  await call(c, "load_context");
  const r = await call(c, "save_summary", { title: "Short", accomplished: "did the thing" });
  assert.equal(r.isError, false, r.text);
  const data = JSON.parse(fs.readFileSync(file, "utf-8"));
  const s = data.sessions.find(x => x.title === "Short");
  assert.equal(s.status, "completed");
  assert.equal(s.next_steps, "");
  await c.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
