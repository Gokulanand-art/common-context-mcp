"use strict";
// Regression test for agents behind generic wrappers (e.g. OpenCode's `execute`
// tool), which never see the zod input schemas and guess argument names from
// prose: save_context(entry, content) instead of (key, value), and
// save_summary(...) without the required title. The server must accept the
// common guesses instead of failing the call.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { tempStore } = require("./helpers");

const SERVER = path.join(__dirname, "..", "dist", "index.js");

async function withClient(agentId, fn) {
  const { dir, file } = tempStore();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, CONTEXT_MCP_FILE: file, CONTEXT_MCP_AGENT_ID: agentId },
    stderr: "ignore",
  });
  const client = new Client({ name: "test-" + agentId, version: "0.0.0" });
  await client.connect(transport);
  try {
    return await fn(client, file);
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const call = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { text: r.content.map(c => c.text).join("\n"), isError: !!r.isError };
};

test("save_context accepts entry/content aliases for key/value", async () => {
  await withClient("alias-agent", async (c, file) => {
    await call(c, "load_context");
    const r = await call(c, "save_context", { entry: "db", content: "postgres 17" });
    assert.equal(r.isError, false, r.text);
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    assert.equal(data.contexts.db.value, "postgres 17");
  });
});

test("save_context still rejects a call with neither key nor alias", async () => {
  await withClient("alias-agent", async (c) => {
    await call(c, "load_context");
    const r = await call(c, "save_context", {}).catch(e => ({ text: String(e), isError: true }));
    assert.equal(r.isError, true);
    assert.match(r.text, /key.*value|Expected.*key/s);
  });
});

test("save_summary without title succeeds with an automatic title", async () => {
  await withClient("alias-agent", async (c, file) => {
    await call(c, "load_context");
    const r = await call(c, "save_summary", { accomplished: "migrated auth to sessions" });
    assert.equal(r.isError, false, r.text);
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    assert.equal(data.sessions[0].status, "completed");
    assert.ok(data.sessions[0].title.length > 0, "session has an automatic title");
  });
});

test("load_context tells the agent to brief on a greeting with no task", async () => {
  await withClient("agent-b", async (c) => {
    const r = await call(c, "load_context");
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /no task.*brief|brief.*no task|what's on their mind/is);
  });
});
