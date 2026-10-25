"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { renderLoad } = require("../dist/render.js");
const { splitArchive, appendArchive } = require("../dist/store.js");
const { INSTRUCTIONS } = require("../dist/server.js");
const { redact } = require("../dist/redact.js");
const agents = require("../scripts/agents.js");
const { tempStore } = require("./helpers");

const SERVER = path.join(__dirname, "..", "dist", "index.js");
// Token counts are estimated as characters / 4. The ceilings below keep the savings from creeping back.
const TOKENS = c => Math.ceil(c / 4);

/** A store much larger than a busy team's: 300 sessions, 200 failures, 150 context entries. */
function bigStore() {
  const now = Date.now();
  const d = { version: 2, created: new Date(now).toISOString(), contexts: {}, sessions: [], failures: [],
    claims: {}, broadcasts: [], patterns: { works: [], fails: [] } };
  for (let i = 0; i < 300; i++) {
    d.sessions.push({ id: `session-${i + 1}`, title: `Work item ${i} ${"t".repeat(60)}`, status: "completed",
      accomplished: "a".repeat(900), learned: "l".repeat(400), decisions: "d".repeat(400), next_steps: "n".repeat(300),
      checkpoint: "c".repeat(200), agent: "claude-code:x", timestamp: new Date(now - i * 3600e3).toISOString(),
      heartbeat: new Date(now).toISOString() });
  }
  for (let i = 0; i < 200; i++) {
    d.failures.push({ approach: `Bash: ${"x".repeat(400)}`, why_failed: "y".repeat(500), agent: "a",
      timestamp: new Date(now - i * 1000).toISOString() });
  }
  for (let i = 0; i < 150; i++) {
    d.contexts[`key.${i}`] = { value: "v".repeat(1200), tags: ["t"], agent: "a",
      updated: new Date(now - i * 1000).toISOString(), history: [] };
  }
  return d;
}

const view = (d, detail, budgetChars = 6000) =>
  renderLoad(d, "session-1", { agentId: "me", staleMs: 900_000, detail, budgetChars });

test("the brief load view stays within its budget on a large store", () => {
  const brief = view(bigStore(), "brief");
  assert.ok(brief.length <= 6000, `brief is ${brief.length} chars`);
  assert.ok(TOKENS(brief.length) <= 1500, `brief is about ${TOKENS(brief.length)} tokens`);
  assert.match(brief, /load_context with detail "full"/);
});

test("the brief view keeps the newest items and drops old sections before a budget overrun", () => {
  const brief = view(bigStore(), "brief", 900);
  assert.ok(brief.length <= 1200, `tiny budget respected, got ${brief.length}`);
  assert.match(brief, /section\(s\) omitted/);
  assert.match(brief, /Your session: session-1/, "the header is always kept");
});

test("the full view keeps everything for debugging", () => {
  const d = bigStore();
  const full = view(d, "full");
  assert.ok(full.length > view(d, "brief").length * 10);
  assert.match(full, /=== END OF CONTEXT ===/);
});

test("the fixed text sent to every agent stays small", async () => {
  assert.ok(TOKENS(INSTRUCTIONS.length) <= 250, `instructions ${INSTRUCTIONS.length} chars`);
  const rules = agents.upsertMarkdown("");
  assert.ok(TOKENS(rules.length) <= 230, `rules block ${rules.length} chars`);
  assert.match(rules, /load_context/);
  assert.match(rules, /save_summary/);

  const { dir, file } = tempStore();
  const env = { ...process.env, CONTEXT_MCP_FILE: file };
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env, stderr: "ignore" });
  const client = new Client({ name: "tokens", version: "0.0.0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const total = tools.reduce((n, t) => n + (t.description || "").length, 0);
    for (const t of tools) {
      assert.ok((t.description || "").length <= 160, `${t.name} description is ${t.description.length} chars`);
      assert.doesNotMatch(t.description, /Requires load_context/, `${t.name} repeats the load requirement`);
    }
    assert.ok(TOKENS(total) <= 400, `tool descriptions total about ${TOKENS(total)} tokens`);
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the archive moves old items out of the live store and nothing is lost", () => {
  const d = bigStore();
  const now = Date.now();
  const moved = splitArchive(d, { keepSessions: 100, days: 30, keepId: null, now });
  assert.equal(d.sessions.length, 100, "newest completed sessions stay");
  assert.equal(moved.sessions.length, 200, "older sessions move");
  assert.equal(d.failures.length, 200, "newest failures stay");
  assert.equal(moved.failures.length, 0, "200 failures are within the limit");

  const again = splitArchive(d, { keepSessions: 100, days: 30, keepId: null, now });
  assert.equal(again.sessions.length + again.failures.length, 0, "a second archive moves nothing");
});

test("the current session is never archived, even when it is old", () => {
  const d = bigStore();
  const keep = d.sessions[299].id;
  splitArchive(d, { keepSessions: 1, days: 0, keepId: keep, now: Date.now() + 1e9 });
  assert.ok(d.sessions.some(s => s.id === keep), "the kept session is still there");
});

test("archived items are written to the archive file as JSON lines", () => {
  const { dir, file } = tempStore();
  const d = bigStore();
  const moved = splitArchive(d, { keepSessions: 100, days: 30, keepId: null, now: Date.now() });
  appendArchive(file, moved.sessions, moved.failures);
  const lines = fs.readFileSync(`${file}.archive.jsonl`, "utf-8").trim().split("\n");
  assert.equal(lines.length, moved.sessions.length);
  assert.equal(JSON.parse(lines[0]).kind, "session");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("credentials are redacted from what the store keeps", () => {
  const out = redact("token=abc123def456ghi789 and Authorization: Bearer abc.def.ghi and sk-abcdefghijklmnop");
  assert.doesNotMatch(out, /abc123def456ghi789|abc\.def\.ghi|sk-abcdefghijklmnop/);
});

test("save_context stores redacted, capped text through the server", async () => {
  const { dir, file } = tempStore();
  const env = { ...process.env, CONTEXT_MCP_FILE: file };
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env, stderr: "ignore" });
  const client = new Client({ name: "redact", version: "0.0.0" });
  await client.connect(transport);
  try {
    await client.callTool({ name: "load_context", arguments: {} });
    await client.callTool({ name: "save_context", arguments: { key: "cfg", value: `api_key=sk-zzzzzzzzzzzzzzzzzzzz ${"z".repeat(5000)}` } });
    const stored = JSON.parse(fs.readFileSync(file, "utf-8")).contexts.cfg.value;
    assert.doesNotMatch(stored, /sk-zzzzzzzzzzzzzzzzzzzz/);
    assert.ok(stored.length <= 4000, `capped at ${stored.length}`);
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the hook sends the full protocol once per session, then a one-line reminder", () => {
  const { spawnSync } = require("node:child_process");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccmcp-home-"));
  const env = { ...process.env, HOME: home };
  delete env.CONTEXT_MCP_FILE;
  const prompt = () => {
    const r = spawnSync(process.execPath, [path.join(__dirname, "..", "dist", "index.js"), "hook", "user-prompt-submit", "--source", "claude-code"], {
      input: JSON.stringify({ session_id: "tok-sess", cwd: home, prompt: "hi" }), env, encoding: "utf-8",
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout).hookSpecificOutput?.additionalContext ?? JSON.parse(r.stdout).context ?? "";
  };
  const first = prompt();
  const second = prompt();
  assert.match(first, /common-context protocol/);
  assert.ok(TOKENS(second.length) <= 60, `reminder is ${second.length} chars`);
  assert.match(second, /load_context/);
  fs.rmSync(home, { recursive: true, force: true });
});
