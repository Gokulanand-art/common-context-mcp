"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { loadConfig } = require("../dist/config.js");

const BIN = path.join(__dirname, "..", "dist", "index.js");

test("the default store is common-context.json in the working directory", () => {
  const cfg = loadConfig({});
  assert.equal(cfg.file, path.join(process.cwd(), "common-context.json"));
});

test("CONTEXT_MCP_PROJECT_DIR picks the folder, and CONTEXT_MCP_FILE overrides the file", () => {
  assert.equal(loadConfig({ CONTEXT_MCP_PROJECT_DIR: "/work/app" }).file, path.resolve("/work/app/common-context.json"));
  assert.equal(loadConfig({ CONTEXT_MCP_PROJECT_DIR: "/work/app", CONTEXT_MCP_FILE: "/x/y.json" }).file, path.resolve("/x/y.json"));
});

test("each project folder gets its own store, and hooks write to the folder they run in", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccmcp-home-"));
  const a = fs.mkdtempSync(path.join(os.tmpdir(), "ccmcp-proj-a-"));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), "ccmcp-proj-b-"));
  const env = { ...process.env, HOME: home, CONTEXT_MCP_ENFORCE: "" };
  delete env.CONTEXT_MCP_FILE;
  delete env.CONTEXT_MCP_PROJECT_DIR;
  const fail = (cwd, message) => {
    const r = spawnSync(process.execPath, [BIN, "hook", "post-tool-use-failure", "--source", "claude-code"], {
      input: JSON.stringify({ session_id: "s1", cwd, tool_name: "Bash", error: message }),
      env,
      encoding: "utf-8",
    });
    assert.equal(r.status, 0, r.stderr);
  };

  fail(a, "error in project A");
  fail(b, "error in project B");

  const storeA = JSON.parse(fs.readFileSync(path.join(a, "common-context.json"), "utf-8"));
  const storeB = JSON.parse(fs.readFileSync(path.join(b, "common-context.json"), "utf-8"));
  assert.equal(storeA.failures.length, 1);
  assert.match(storeA.failures[0].why_failed, /project A/);
  assert.equal(storeB.failures.length, 1);
  assert.match(storeB.failures[0].why_failed, /project B/);
  assert.equal(fs.existsSync(path.join(home, ".shared-context.json")), false, "no global store is created");

  for (const d of [home, a, b]) fs.rmSync(d, { recursive: true, force: true });
});
