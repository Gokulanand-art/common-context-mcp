"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { tempStore } = require("./helpers");

const agents = require("../scripts/agents.js");
const SETUP = path.join(__dirname, "..", "scripts", "postinstall.js");

test("Codex TOML: adds a managed block and keeps other tables", () => {
  const text = '[model]\nname = "x"\n\n[mcp_servers.other]\ncommand = "other"\n';
  const out = agents.withTomlServer(text);
  assert.match(out, /\[model\]/);
  assert.match(out, /\[mcp_servers\.other\]/);
  assert.match(out, /# common-context:start\n\[mcp_servers\.common-context\]\ncommand = "common-context-mcp"\ndefault_tools_approval_mode = "approve"\n# common-context:end/);
  assert.equal(agents.withTomlServer(out), out, "idempotent");
});

test("Codex TOML: refuses to clobber a user-defined common-context table", () => {
  const text = '[mcp_servers.common-context]\ncommand = "mine"\n';
  assert.throws(() => agents.withTomlServer(text), /already defines/);
});

test("Markdown rules: the block goes first, is replaced on rerun, and keeps surrounding text", () => {
  const first = agents.upsertMarkdown("# My rules\n\nBe concise.\n");
  assert.match(first, /^<!-- common-context:start -->/, "protocol is the first thing the agent reads");
  assert.match(first, /load_context/);
  assert.match(first, /# My rules\n\nBe concise\.\n$/, "the user's own rules are kept after it");
  const edited = first.replace("Be concise.", "Be concise and kind.") + "\nMore notes.\n";
  const again = agents.upsertMarkdown(edited);
  assert.match(again, /Be concise and kind\./, "text outside the block kept");
  assert.match(again, /More notes\./);
  assert.equal((again.match(/common-context:start/g) || []).length, 1, "single block");
  assert.equal(agents.upsertMarkdown(again), again, "idempotent");
});

test("JSON MCP merge: OpenCode uses the mcp key with a command array", () => {
  const out = agents.withJsonServer({ mcp: { other: { type: "local", command: ["x"] } } }, "mcp",
    { type: "local", command: ["common-context-mcp"] });
  assert.deepEqual(out.mcp.other, { type: "local", command: ["x"] });
  assert.deepEqual(out.mcp["common-context"], { type: "local", command: ["common-context-mcp"] });
});

test("JSON MCP merge: replaces the legacy command and leaves a custom entry alone", () => {
  const legacy = agents.withJsonServer({ mcpServers: { "common-context": { command: "agent-nervous-system-mcp" } } },
    "mcpServers", { command: "common-context-mcp" });
  assert.equal(legacy.mcpServers["common-context"].command, "common-context-mcp");
  const custom = agents.withJsonServer({ mcpServers: { "common-context": { command: "/my/path" } } },
    "mcpServers", { command: "common-context-mcp" });
  assert.equal(custom.mcpServers["common-context"].command, "/my/path");
});

test("registry covers exactly the five supported tools", () => {
  assert.deepEqual(agents.AGENTS.map(a => a.id).sort(), ["claude-code", "codex", "cursor", "gemini", "opencode"]);
  assert.equal(agents.AGENTS.find(a => a.id === "cursor").rules, null, "Cursor rules are a manual step");
  assert.deepEqual(agents.AGENTS.filter(a => a.hooks).map(a => a.id).sort(), ["claude-code", "codex", "cursor", "gemini", "opencode"], "all five tools get enforcement");
});

test("end to end over a fake home: every detected tool gets its MCP entry and protocol rules", () => {
  const { dir } = tempStore();
  for (const d of [".claude", ".cursor", ".codex", ".gemini", ".config/opencode"]) {
    fs.mkdirSync(path.join(dir, d), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ numStartups: 3 }));
  const r = spawnSync(process.execPath, [SETUP, "--yes"], {
    env: { ...process.env, HOME: dir, PATH: "/nonexistent", npm_lifecycle_event: "", CONTEXT_MCP_NO_HOOKS: "1" },
    encoding: "utf-8",
  });
  assert.equal(r.status, 0, r.stderr);

  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, ".claude.json"), "utf-8")).mcpServers["common-context"].command, "common-context-mcp");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, ".cursor", "mcp.json"), "utf-8")).mcpServers["common-context"].command, "common-context-mcp");
  assert.match(fs.readFileSync(path.join(dir, ".codex", "config.toml"), "utf-8"), /\[mcp_servers\.common-context\]/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, ".gemini", "settings.json"), "utf-8")).mcpServers["common-context"].command, "common-context-mcp");
  const oc = JSON.parse(fs.readFileSync(path.join(dir, ".config", "opencode", "opencode.json"), "utf-8"));
  assert.deepEqual(oc.mcp["common-context"].command, ["common-context-mcp"]);

  for (const rules of [".claude/CLAUDE.md", ".codex/AGENTS.md", ".gemini/GEMINI.md", ".config/opencode/AGENTS.md"]) {
    assert.match(fs.readFileSync(path.join(dir, rules), "utf-8"), /common-context:start/, rules);
  }
  assert.match(r.stderr, /Cursor\n.*manual step/s);
  assert.equal(fs.existsSync(path.join(dir, ".claude", "settings.json")), false, "hooks disabled by env");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("no tool detected: nothing is written and supported tools are listed", () => {
  const { dir } = tempStore();
  const r = spawnSync(process.execPath, [SETUP, "--yes"], {
    env: { ...process.env, HOME: dir, PATH: "/nonexistent", npm_lifecycle_event: "" },
    encoding: "utf-8",
  });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /Supported tools: Claude Code, Cursor, Codex CLI, Gemini CLI, OpenCode/);
  assert.equal(fs.existsSync(path.join(dir, ".codex")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Codex TOML: hooks are written as [[hooks.<Event>]] tables tagged with the Codex source", () => {
  const out = agents.withTomlServer("", { withHooks: true });
  assert.match(out, /\[mcp_servers\.common-context\]/);
  assert.match(out, /\[\[hooks\.PreToolUse\]\]\nmatcher = "\*"/);
  assert.match(out, /\[\[hooks\.PreToolUse\.hooks\]\]\ntype = "command"\ncommand = "common-context-mcp hook pre-tool-use --source codex"/);
  assert.match(out, /\[\[hooks\.Stop\.hooks\]\]/);
  // Rerunning without hooks removes only the managed block's hook tables.
  const mcpOnly = agents.withTomlServer(out, { withHooks: false });
  assert.doesNotMatch(mcpOnly, /hooks\./);
  assert.match(mcpOnly, /\[mcp_servers\.common-context\]/);
});

test("Codex TOML: a quoted user-defined common-context table is also protected", () => {
  assert.throws(() => agents.withTomlServer('[mcp_servers."common-context"]\ncommand = "mine"\n'), /already defines/);
});

test("Codex rules: AGENTS.override.md is used when it exists, AGENTS.md otherwise", () => {
  const { dir } = tempStore();
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
  try {
    assert.equal(agents.codexRulesFile(), path.join(dir, "AGENTS.md"));
    fs.writeFileSync(path.join(dir, "AGENTS.override.md"), "override\n");
    assert.equal(agents.codexRulesFile(), path.join(dir, "AGENTS.override.md"));
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("end to end: CODEX_HOME moves every Codex file, hooks included, and the override file gets the protocol", () => {
  const { dir } = tempStore();
  const codexDir = path.join(dir, "custom-codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, "AGENTS.override.md"), "# mine\n");
  const r = spawnSync(process.execPath, [SETUP, "--yes"], {
    env: { ...process.env, HOME: dir, CODEX_HOME: codexDir, PATH: "/nonexistent", npm_lifecycle_event: "" },
    encoding: "utf-8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(codexDir, "config.toml"), "utf-8"), /\[\[hooks\.PreToolUse\]\]/);
  assert.match(fs.readFileSync(path.join(codexDir, "AGENTS.override.md"), "utf-8"), /common-context:start/);
  assert.equal(fs.existsSync(path.join(codexDir, "AGENTS.md")), false, "AGENTS.md not created when override is used");
  assert.match(r.stderr, /approve them/, "user is told hooks need approval");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the real Codex CLI accepts the managed config (skipped when codex is not installed)", t => {
  const probe = spawnSync("which", ["codex"], { encoding: "utf-8" });
  if (probe.status !== 0) return t.skip("codex not installed");
  const { dir } = tempStore();
  fs.writeFileSync(path.join(dir, "config.toml"), agents.withTomlServer("", { withHooks: true }));
  const r = spawnSync("codex", ["debug", "prompt-input"], {
    env: { ...process.env, CODEX_HOME: dir },
    encoding: "utf-8",
    cwd: dir,
    timeout: 60000,
  });
  assert.equal(r.status, 0, r.stderr);
  fs.rmSync(dir, { recursive: true, force: true });
});

const { spawnSync: spawnSyncNode } = require("node:child_process");
const { runFixture } = { runFixture: null };

test("Cursor hooks.json: merges our events, keeps the user's own hooks, reruns are no-ops", () => {
  const user = { version: 1, hooks: { stop: [{ command: "./my-notify.sh" }] } };
  const once = agents.withCursorHooks(user);
  assert.equal(once.hooks.stop.length, 2, "user hook kept beside ours");
  assert.ok(once.hooks.stop.some(h => h.command === "./my-notify.sh"));
  assert.equal(once.hooks.preToolUse[0].command, "common-context-mcp hook pre-tool-use --source cursor");
  assert.equal(once.hooks.beforeSubmitPrompt[0].command, "common-context-mcp hook user-prompt-submit --source cursor");
  const twice = agents.withCursorHooks(once);
  assert.deepEqual(twice, once, "idempotent");
});

test("Gemini settings hooks: uses Gemini's event names and keeps other settings", () => {
  const user = { security: { auth: "x" }, hooks: { BeforeTool: [{ matcher: "write_file", hooks: [{ type: "command", command: "/my/check.sh" }] }] } };
  const out = agents.withGeminiHooks(user);
  assert.equal(out.security.auth, "x");
  assert.equal(out.hooks.BeforeTool.length, 2, "user's own BeforeTool hook kept");
  assert.equal(out.hooks.BeforeTool[1].hooks[0].command, "common-context-mcp hook pre-tool-use --source gemini");
  assert.equal(out.hooks.BeforeAgent[0].hooks[0].command, "common-context-mcp hook user-prompt-submit --source gemini");
  assert.equal(out.hooks.AfterAgent[0].hooks[0].command, "common-context-mcp hook stop --source gemini");
  assert.deepEqual(agents.withGeminiHooks(out), out, "idempotent");
});

test("OpenCode plugin: is a JS module that blocks tool calls through the hook CLI", () => {
  const src = agents.openCodePlugin();
  assert.match(src, /^\/\/ common-context-mcp managed plugin/);
  assert.match(src, /hook", event, "--source", "opencode"/);
  assert.match(src, /throw new Error\(decision\.reason\)/);
  assert.match(src, /export default \{\n  id: "common-context",\n  setup: async \(ctx\) =>/, "OpenCode loads plugins from the default export with id and setup");
  assert.match(src, /ctx\.tool\.hook\("execute\.before"/, "tool calls are gated through the documented hook");
});

test("end to end: Cursor, Gemini and OpenCode hook replies use each tool's format", () => {
  const { dir } = tempStore();
  const env = { ...process.env, HOME: dir, CONTEXT_MCP_FILE: path.join(dir, "store.json") };
  const bin = path.join(__dirname, "..", "dist", "index.js");
  const call = (event, source, payload) => JSON.parse(spawnSync(process.execPath, [bin, "hook", event, "--source", source], {
    input: JSON.stringify(payload), env, encoding: "utf-8",
  }).stdout);

  // Cursor: prompt, then a tool call before any MCP call must be denied with permission: deny.
  call("user-prompt-submit", "cursor", { conversation_id: "c1", prompt: "hi" });
  const cursorDeny = call("pre-tool-use", "cursor", { conversation_id: "c1", tool_name: "Shell", tool_input: { command: "ls" } });
  assert.equal(cursorDeny.permission, "deny");
  assert.match(cursorDeny.agent_message, /load_context/);

  // Gemini: same flow, Gemini's decision format.
  call("user-prompt-submit", "gemini", { session_id: "g1", prompt: "hi" });
  const geminiDeny = call("pre-tool-use", "gemini", { session_id: "g1", tool_name: "run_shell_command", tool_input: {} });
  assert.equal(geminiDeny.decision, "deny");
  assert.match(geminiDeny.reason, /load_context/);

  // OpenCode: its plugin reads the same deny format.
  call("user-prompt-submit", "opencode", { session_id: "o1", prompt: "hi" });
  const ocDeny = call("pre-tool-use", "opencode", { session_id: "o1", tool_name: "bash", tool_input: {} });
  assert.equal(ocDeny.decision, "deny");

  // A Gemini stop with work done and no summary is blocked with decision: block.
  call("post-tool-use", "gemini", { session_id: "g1", tool_name: "replace", tool_input: {}, tool_response: { llmContent: "ok" } });
  const geminiStop = call("stop", "gemini", { session_id: "g1", stop_hook_active: false, prompt_response: "done" });
  assert.equal(geminiStop.decision, "block");
  assert.match(geminiStop.reason, /save_summary/);

  // Cursor stop uses followup_message to keep the agent working.
  const cursorStop = call("stop", "cursor", { conversation_id: "c1", loop_count: 0 });
  assert.match(cursorStop.followup_message, /search_context|save_summary/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("MCP tool names match under every tool's naming scheme, and nothing else", () => {
  const { mcpName } = require("../dist/hooks.js");
  assert.equal(mcpName("mcp__common-context__load_context"), "load_context");
  assert.equal(mcpName("mcp_common-context_save_summary"), "save_summary");
  assert.equal(mcpName("common-context_search_context"), "search_context");
  assert.equal(mcpName("mcp__common-context-other__load_context"), null);
  assert.equal(mcpName("Bash"), null);
});

test("OpenCode plugin: registers both tool hooks and disposes them on cleanup", () => {
  const src = agents.openCodePlugin();
  assert.match(src, /ctx\.tool\.hook\("execute\.after"/);
  assert.match(src, /r\.dispose\(\)/);
  const { writeFileSync, mkdtempSync, rmSync } = require("node:fs");
  const dir = mkdtempSync(path.join(require("node:os").tmpdir(), "ocp-"));
  const f = path.join(dir, "plugin.mjs");
  writeFileSync(f, src);
  const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf-8" });
  assert.equal(r.status, 0, r.stderr);
  rmSync(dir, { recursive: true, force: true });
});

test("Codex MCP entry pre-approves only the common-context tools", () => {
  const out = agents.withTomlServer("");
  assert.match(out, /\[mcp_servers\.common-context\]\ncommand = "common-context-mcp"\ndefault_tools_approval_mode = "approve"/);
});

test("Codex underscore tool names are recognised as ours", () => {
  const { mcpName } = require("../dist/hooks.js");
  assert.equal(mcpName("mcp__common_context__load_context"), "load_context");
  assert.equal(mcpName("mcp__common_context__save_summary"), "save_summary");
});

test("Codex hook approvals written inside the managed block survive a rewrite", () => {
  const approved = agents.withTomlServer("", { withHooks: true }).replace(
    "# common-context:end",
    '[hooks.state."/x/config.toml:stop:0:0"]\ntrusted_hash = "sha256:abc"\n# common-context:end'
  );
  const rewritten = agents.withTomlServer(approved, { withHooks: true });
  assert.match(rewritten, /\[hooks\.state\."\/x\/config\.toml:stop:0:0"\]\ntrusted_hash = "sha256:abc"/);
  assert.equal(agents.withTomlServer(rewritten, { withHooks: true }), rewritten, "stable across reruns");
});

test("OpenCode execute and search calls that reach common-context count as our MCP calls", () => {
  const { wrappedMcpName } = require("../dist/hooks.js");
  assert.equal(wrappedMcpName("execute", { code: 'const ctx = await tools["common-context"].load_context();' }), "load_context");
  assert.equal(wrappedMcpName("search", { query: "load_context", namespace: "common-context" }), "load_context");
  assert.equal(wrappedMcpName("execute", { code: "echo hi" }), null, "other code is not ours");
  assert.equal(wrappedMcpName("bash", { code: 'tools["common-context"].load_context()' }), null, "only wrapper tools");
});
