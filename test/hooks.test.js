"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { tempStore } = require("./helpers");

const BIN = path.join(__dirname, "..", "dist", "index.js");
const SID = "test-session";
const M = "mcp__common-context__";

function setup() {
  const { dir, file } = tempStore();
  const env = { ...process.env, HOME: dir, CONTEXT_MCP_FILE: file, CONTEXT_MCP_ENFORCE: "" };
  delete env.CONTEXT_MCP_ENFORCE;
  const hook = (event, input = {}) => {
    const r = spawnSync(process.execPath, [BIN, "hook", event], {
      input: JSON.stringify({ session_id: SID, hook_event_name: event, ...input }),
      env,
      encoding: "utf-8",
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const store = () => JSON.parse(fs.readFileSync(file, "utf-8"));
  return { dir, hook, store };
}

const pre = (tool) => ({ tool_name: tool, tool_input: {} });
const post = (tool, response = {}) => ({ tool_name: tool, tool_input: {}, tool_response: response });

test("a message is blocked until load_context runs, then allowed", () => {
  const { dir, hook } = setup();
  hook("UserPromptSubmit", { prompt: "fix the build" });
  let out = hook("PreToolUse", pre("Bash"));
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.systemMessage, /load_context before any work/);

  hook("PostToolUse", post(M + "load_context", { text: "Your session: session-3 (agent x)" }));
  out = hook("PreToolUse", pre("Bash"));
  assert.equal(out.hookSpecificOutput, undefined, "allowed");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("every new message must call the MCP again before work", () => {
  const { dir, hook } = setup();
  hook("UserPromptSubmit", {});
  hook("PostToolUse", post(M + "load_context", { text: "Your session: session-1" }));
  hook("PostToolUse", post("Read"));
  hook("UserPromptSubmit", {});
  const out = hook("PreToolUse", pre("Read"));
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /for this message/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an error is recorded in the store and blocks alternatives until searched", () => {
  const { dir, hook, store } = setup();
  hook("UserPromptSubmit", {});
  hook("PostToolUse", post(M + "load_context", { text: "Your session: session-1" }));

  const failed = hook("PostToolUse", post("Bash", { stdout: "", stderr: "ENOENT", exit_code: 2 }));
  assert.match(failed.systemMessage, /error recorded in the shared store/);
  const data = store();
  assert.equal(data.failures.length, 1);
  assert.match(data.failures[0].why_failed, /exit code 2/);
  assert.equal(data.failures[0].agent, `claude-code:${SID}`);

  const blocked = hook("PreToolUse", pre("Edit"));
  assert.equal(blocked.hookSpecificOutput.permissionDecision, "deny");
  assert.match(blocked.hookSpecificOutput.permissionDecisionReason, /search_context/);

  hook("PostToolUse", post(M + "search_context", { text: "Found 1 results" }));
  assert.equal(hook("PreToolUse", pre("Edit")).hookSpecificOutput, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("failed tool calls (PostToolUseFailure) are recorded too", () => {
  const { dir, hook, store } = setup();
  hook("UserPromptSubmit", {});
  hook("PostToolUse", post(M + "load_context", { text: "Your session: session-1" }));
  hook("PostToolUseFailure", { tool_name: "Bash", tool_input: { command: "npm ci" }, error: "lock file mismatch" });
  assert.equal(store().failures.length, 1);
  assert.match(store().failures[0].why_failed, /lock file mismatch/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("final answer is held until save_summary when work was done", () => {
  const { dir, hook } = setup();
  hook("UserPromptSubmit", {});
  hook("PostToolUse", post(M + "load_context", { text: "Your session: session-1" }));
  hook("PostToolUse", post("Edit"));

  const held = hook("Stop", {});
  assert.equal(held.decision, "block");
  assert.match(held.reason, /save_summary/);

  hook("PostToolUse", post(M + "save_summary", { text: "Session summary saved." }));
  const done = hook("Stop", {});
  assert.equal(done.decision, undefined);
  assert.match(done.systemMessage, /summary saved/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a message with no MCP call is held even without tool work", () => {
  const { dir, hook } = setup();
  hook("UserPromptSubmit", {});
  const held = hook("Stop", {});
  assert.equal(held.decision, "block");
  assert.match(held.reason, /search_context/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("after repeated holds the stop is allowed and the summary is recorded automatically", () => {
  const { dir, hook, store } = setup();
  hook("UserPromptSubmit", {});
  hook("PostToolUse", post(M + "load_context", { text: "Your session: session-1" }));
  hook("PostToolUse", post("Edit"));
  assert.equal(hook("Stop", {}).decision, "block");
  const forced = hook("Stop", { stop_hook_active: true, last_assistant_message: "Fixed the import." });
  assert.equal(forced.decision, undefined, "allowed after the hold");
  assert.match(forced.systemMessage, /summary was recorded automatically/);
  const s = store().sessions.find(x => x.accomplished === "Fixed the import.");
  assert.ok(s, "auto-summary written to the store");
  assert.equal(s.status, "completed");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("CONTEXT_MCP_ENFORCE=0 turns enforcement off", () => {
  const { dir, file } = tempStore();
  const r = spawnSync(process.execPath, [BIN, "hook", "PreToolUse"], {
    input: JSON.stringify({ session_id: SID, tool_name: "Bash" }),
    env: { ...process.env, HOME: dir, CONTEXT_MCP_FILE: file, CONTEXT_MCP_ENFORCE: "0" },
    encoding: "utf-8",
  });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a hook error fails open with a visible warning", () => {
  const { dir, hook } = setup();
  const out = hook("NoSuchEvent", {});
  assert.match(out.systemMessage, /hook error/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("ToolSearch stays reachable before load, so MCP schemas can be fetched", () => {
  const { dir, hook } = setup();
  hook("UserPromptSubmit", {});
  assert.equal(hook("PreToolUse", pre("ToolSearch")).hookSpecificOutput, undefined);
  assert.equal(hook("PreToolUse", pre("Bash")).hookSpecificOutput.permissionDecision, "deny");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("credentials in failed commands are redacted before reaching the store", () => {
  const { dir, hook, store } = setup();
  hook("UserPromptSubmit", {});
  hook("PostToolUse", post(M + "load_context", { text: "Your session: session-1" }));
  hook("PostToolUseFailure", {
    tool_name: "Bash",
    tool_input: { command: "curl -H 'Authorization: Bearer abc123SECRETtoken' https://x --token=ghp_1234567890abcdefXYZ" },
    error: "401 password=hunter2 denied",
  });
  const f = store().failures[0];
  const text = f.approach + " " + f.why_failed;
  assert.doesNotMatch(text, /abc123SECRETtoken|ghp_1234567890abcdefXYZ|hunter2/);
  assert.match(text, /REDACTED/);
  fs.rmSync(dir, { recursive: true, force: true });
});
test("OpenCode wrapped load_context unblocks the gate end to end", () => {
  const { dir, hook } = setup();
  const wrapped = { session_id: "oc-wrap", tool_name: "execute", tool_input: { code: 'tools["common-context"].load_context();' } };
  assert.equal(hook("PreToolUse", wrapped).hookSpecificOutput, undefined, "the wrapped load is allowed");
  hook("PostToolUse", { ...wrapped, tool_response: { text: "Your session: session-5" } });
  assert.equal(hook("PreToolUse", { session_id: "oc-wrap", tool_name: "Bash", tool_input: {} }).hookSpecificOutput, undefined, "work is allowed after load");
  fs.rmSync(dir, { recursive: true, force: true });
});
