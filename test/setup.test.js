"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { tempStore } = require("./helpers");

const SETUP = path.join(__dirname, "..", "scripts", "postinstall.js");

function fakeHome({ jsonc = false } = {}) {
  const { dir } = tempStore();
  fs.mkdirSync(path.join(dir, ".cursor"));
  fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({
    numStartups: 7,
    mcpServers: { rea: { command: "/usr/bin/rea", args: ["mcp"] }, "common-context": { command: "agent-nervous-system-mcp" } },
  }));
  if (jsonc) {
    // JSONC with comments: must be left untouched, not overwritten.
    fs.writeFileSync(path.join(dir, ".cursor", "mcp.json"), "{ // my comment\n \"mcpServers\": {} }");
  }
  return dir;
}

const run = (home, args = []) =>
  spawnSync(process.execPath, [SETUP, ...args], {
    env: { ...process.env, HOME: home, npm_lifecycle_event: "", CONTEXT_MCP_FILE: "" },
    encoding: "utf-8",
  });

test("merges into Claude Code config, keeps other servers, upgrades legacy command", () => {
  const home = fakeHome();
  const r = run(home, ["--yes"]);
  assert.equal(r.status, 0, r.stderr);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf-8"));
  assert.equal(cfg.numStartups, 7, "unrelated keys preserved");
  assert.deepEqual(cfg.mcpServers.rea, { command: "/usr/bin/rea", args: ["mcp"] }, "other servers preserved");
  assert.equal(cfg.mcpServers["common-context"].command, "common-context-mcp", "legacy command upgraded");
  const backups = fs.readdirSync(home).filter(f => f.startsWith(".claude.json.bak-"));
  assert.equal(backups.length, 1, "backup written before change");
  fs.rmSync(home, { recursive: true, force: true });
});

test("re-running is idempotent and writes nothing new", () => {
  const home = fakeHome();
  run(home, ["--yes"]);
  const before = fs.readFileSync(path.join(home, ".claude.json"), "utf-8");
  const r = run(home, ["--yes"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(home, ".claude.json"), "utf-8"), before);
  assert.match(r.stderr, /already configured|unchanged/);
  fs.rmSync(home, { recursive: true, force: true });
});

test("a config that is not plain JSON is skipped, never overwritten", () => {
  const home = fakeHome({ jsonc: true });
  const jsonc = path.join(home, ".cursor", "mcp.json");
  const original = fs.readFileSync(jsonc, "utf-8");
  const r = run(home, ["--yes"]);
  assert.equal(fs.readFileSync(jsonc, "utf-8"), original);
  assert.match(r.stderr, /cannot safely edit/);
  assert.equal(r.status, 1, "reports failure in exit code");
  fs.rmSync(home, { recursive: true, force: true });
});

test("npm local install does not touch agent configs", () => {
  const home = fakeHome();
  const before = fs.readFileSync(path.join(home, ".claude.json"), "utf-8");
  const r = spawnSync(process.execPath, [SETUP], {
    env: { ...process.env, HOME: home, npm_lifecycle_event: "postinstall", npm_config_global: "" },
    encoding: "utf-8",
  });
  assert.equal(r.status, 0);
  assert.equal(fs.readFileSync(path.join(home, ".claude.json"), "utf-8"), before);
  assert.match(r.stderr, /Local install: tool setup skipped/);
  fs.rmSync(home, { recursive: true, force: true });
});

test("keeps the original file mode (0600 agent configs stay private)", () => {
  const home = fakeHome();
  const file = path.join(home, ".claude.json");
  fs.chmodSync(file, 0o600);
  run(home, ["--yes"]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.rmSync(home, { recursive: true, force: true });
});

test("installs Claude Code enforcement hooks, keeping the user's own hooks", () => {
  const home = fakeHome();
  const settings = path.join(home, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({
    theme: "dark",
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/my/lint.sh" }] }] },
  }));
  const r = run(home, ["--yes"]);
  assert.equal(r.status, 0, r.stderr);
  const cfg = JSON.parse(fs.readFileSync(settings, "utf-8"));
  assert.equal(cfg.theme, "dark");
  const pre = cfg.hooks.PreToolUse.map(g => g.hooks[0].command);
  assert.ok(pre.includes("/my/lint.sh"), "user hook kept");
  assert.ok(pre.includes("common-context-mcp hook pre-tool-use"), "our hook added");
  assert.equal(cfg.hooks.PreToolUse.find(g => g.hooks[0].command.includes("hook pre-tool-use")).matcher, "*");
  assert.ok(cfg.hooks.Stop.some(g => g.hooks[0].command === "common-context-mcp hook stop"));
  assert.ok(cfg.hooks.UserPromptSubmit && cfg.hooks.PostToolUseFailure, "all events present");

  // Rerun must not duplicate our entries.
  const before = fs.readFileSync(settings, "utf-8");
  run(home, ["--yes"]);
  assert.equal(fs.readFileSync(settings, "utf-8"), before);
  fs.rmSync(home, { recursive: true, force: true });
});

test("CONTEXT_MCP_NO_HOOKS skips hook installation", () => {
  const home = fakeHome();
  spawnSync(process.execPath, [SETUP, "--yes"], {
    env: { ...process.env, HOME: home, npm_lifecycle_event: "", CONTEXT_MCP_NO_HOOKS: "1" },
    encoding: "utf-8",
  });
  assert.equal(fs.existsSync(path.join(home, ".claude", "settings.json")), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test("without a terminal and without --yes, nothing is written", () => {
  const home = fakeHome();
  const before = fs.readFileSync(path.join(home, ".claude.json"), "utf-8");
  const r = spawnSync(process.execPath, [SETUP], {
    env: { ...process.env, HOME: home, npm_lifecycle_event: "", CONTEXT_MCP_NO_HOOKS: "" },
    encoding: "utf-8",
    input: "",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(home, ".claude.json"), "utf-8"), before);
  assert.equal(fs.existsSync(path.join(home, ".claude", "settings.json")), false);
  assert.match(r.stderr, /Not running in a terminal, so nothing was configured/);
  fs.rmSync(home, { recursive: true, force: true });
});

test("global npm install never writes agent configs without a terminal", () => {
  const home = fakeHome();
  const before = fs.readFileSync(path.join(home, ".claude.json"), "utf-8");
  const r = spawnSync(process.execPath, [SETUP], {
    env: { ...process.env, HOME: home, npm_lifecycle_event: "postinstall", npm_config_global: "true" },
    encoding: "utf-8",
    input: "",
  });
  assert.equal(r.status, 0);
  assert.equal(fs.readFileSync(path.join(home, ".claude.json"), "utf-8"), before);
  fs.rmSync(home, { recursive: true, force: true });
});

test("selection parser accepts numbers, all, none and ignores junk", () => {
  const { parseSelection } = require("../scripts/postinstall.js");
  const d = ["a", "b", "c"];
  assert.deepEqual(parseSelection("", d), []);
  assert.deepEqual(parseSelection("none", d), []);
  assert.deepEqual(parseSelection("all", d), d);
  assert.deepEqual(parseSelection("3, 1", d), ["c", "a"]);
  assert.deepEqual(parseSelection("1 1 9 x", d), ["a"]);
});
