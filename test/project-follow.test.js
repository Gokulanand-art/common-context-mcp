"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { ListRootsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");

const BIN = path.join(__dirname, "..", "dist", "index.js");

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function connect(launchDir, home, roots) {
  const env = { ...process.env, HOME: home };
  delete env.CONTEXT_MCP_FILE;
  delete env.CONTEXT_MCP_PROJECT_DIR;
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN], cwd: launchDir, env, stderr: "ignore" });
  const client = new Client({ name: "follow-test", version: "1.0.0" }, { capabilities: { roots: {} } });
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: pathToFileURL(roots.current).href, name: "project" }],
  }));
  await client.connect(transport);
  return client;
}

const text = r => r.content.map(c => c.text).join("\n");

test("the server follows the client's workspace folder and keeps one store per folder", async () => {
  const home = tmp("ccmcp-home-");
  const a = tmp("ccmcp-a-");
  const b = tmp("ccmcp-b-");
  const roots = { current: a };
  const client = await connect(a, home, roots);
  try {
    // Folder A: load, then checkpoint a fact.
    assert.match(text(await client.callTool({ name: "load_context", arguments: {} })), /Your session:/);
    await client.callTool({ name: "save_context", arguments: { key: "fact.a", value: "belongs to A" } });
    const storeA = JSON.parse(fs.readFileSync(path.join(a, "common-context.json"), "utf-8"));
    assert.ok(storeA.contexts["fact.a"], "A's fact is in A's store");

    // Switch the workspace to B. The old session does not carry over, so loading is required again.
    roots.current = b;
    const blocked = await client.callTool({ name: "search_context", arguments: { query: "A" } });
    assert.equal(blocked.isError, true);
    assert.match(text(blocked), /load_context/);

    assert.match(text(await client.callTool({ name: "load_context", arguments: {} })), /Your session:/);
    await client.callTool({ name: "save_context", arguments: { key: "fact.b", value: "belongs to B" } });

    const storeB = JSON.parse(fs.readFileSync(path.join(b, "common-context.json"), "utf-8"));
    assert.ok(storeB.contexts["fact.b"], "B's fact is in B's store");
    assert.equal(storeB.contexts["fact.a"], undefined, "A's fact is not in B's store");

    const storeAAfter = JSON.parse(fs.readFileSync(path.join(a, "common-context.json"), "utf-8"));
    assert.equal(storeAAfter.contexts["fact.b"], undefined, "B's fact is not in A's store");

    // Back to A: A's data is still there and the session is A's again.
    roots.current = a;
    const found = await client.callTool({ name: "load_context", arguments: {} });
    assert.match(text(found), /fact\.a|belongs to A/);
  } finally {
    await client.close();
    for (const d of [home, a, b]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test("without client roots the server uses the folder it started in", async () => {
  const home = tmp("ccmcp-home-");
  const a = tmp("ccmcp-a-");
  const env = { ...process.env, HOME: home };
  delete env.CONTEXT_MCP_FILE;
  delete env.CONTEXT_MCP_PROJECT_DIR;
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN], cwd: a, env, stderr: "ignore" });
  const client = new Client({ name: "no-roots", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    await client.callTool({ name: "load_context", arguments: {} });
    assert.ok(fs.existsSync(path.join(a, "common-context.json")), "store created in the launch folder");
  } finally {
    await client.close();
    for (const d of [home, a]) fs.rmSync(d, { recursive: true, force: true });
  }
});
