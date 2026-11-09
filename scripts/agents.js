"use strict";
/**
 * Registry of the AI coding tools this package configures, plus the file
 * writers they share. Each tool gets:
 *
 *   1. MCP server registration in the tool's own config file.
 *   2. The protocol written into the tool's rules / system-prompt file, inside a
 *      managed block that reruns replace and uninstall can remove.
 *   3. For tools with hooks (Claude Code, Codex CLI), enforcement hooks that
 *      block work until the protocol is followed.
 *
 * Locations were checked against the tools' documentation and, for Codex, against
 * the installed binary (see README). Cursor's global User Rules can only be set in
 * its settings UI, so Cursor gets a manual step instead of a file write. Freebuff,
 * Kilo Code, Cline and Goose were checked against their docs and source; Muse,
 * Qwen Code, Zed, Windsurf and Kiro were checked against their docs too. Muse and
 * Zed document no global rules file, so they get a manual step like Cursor. Aider
 * has no MCP client, so it is listed but never written.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const HOME = os.homedir();
const SERVER_KEY = "common-context";
const COMMAND = "common-context-mcp";
const LEGACY_COMMANDS = ["agent-nervous-system-mcp"];

const MD_START = "<!-- common-context:start -->";
const MD_END = "<!-- common-context:end -->";
const TOML_START = "# common-context:start";
const TOML_END = "# common-context:end";

const PROTOCOL_FILE = path.join(HOME, ".config", "common-context", "PROTOCOL.md");

/** Codex reads its global files from $CODEX_HOME, which defaults to ~/.codex. */
const codexHome = () => (process.env.CODEX_HOME && process.env.CODEX_HOME.trim()) || path.join(HOME, ".codex");

/** The rules every selected agent follows. Tool names may be prefixed by the agent. */
const PROTOCOL = `## common-context protocol (mandatory)

This machine shares one context store across AI agents through the \`common-context\` MCP server. Every model and agent with it installed follows this on every message, including greetings:

1. Before any other tool call or reply: \`load_context\` (first message of a session) or \`search_context\`.
2. After each meaningful step: \`save_context\` (the checkpoint).
3. On a failure: \`save_failure\`, then \`search_context\` before any alternative.
4. Before editing a shared file: \`claim_area\`; \`release_area\` when done.
5. Before the final answer: \`save_context\` with the final state, then \`save_summary\` (accomplished, learned, decisions, next_steps). Answer only after both succeed.

If the \`common-context\` tools are unavailable, say so and continue.
`;

// ─── helpers ──────────────────────────────────────────────────────────

const exists = p => fs.existsSync(p);

function which(cmd) {
  const probe = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(probe, [cmd], { stdio: "ignore" });
  return r.status === 0;
}

/** Parses a JSON object file. Missing or blank files are `{}`. Anything else throws. */
function readJsonStrict(file) {
  if (!exists(file)) return {};
  const raw = fs.readFileSync(file, "utf-8");
  if (raw.trim() === "") return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`cannot safely edit ${file} (${e.message}); it may contain comments. Add the server by hand, see README`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`cannot safely edit ${file}: top level is not a JSON object`);
  }
  return parsed;
}

function readText(file) {
  return exists(file) ? fs.readFileSync(file, "utf-8") : "";
}

/**
 * Writes `after` to `file` only when it differs from `before`. Keeps a timestamped
 * backup and the original permissions (configs often hold API keys).
 */
/** Keeps only the newest backups of a file; ISO stamps sort chronologically. Best-effort. */
function pruneBackups(file) {
  try {
    const dir = path.dirname(file);
    const prefix = `${path.basename(file)}.bak-`;
    const matches = fs.readdirSync(dir).filter(f => f.startsWith(prefix)).sort();
    for (const f of matches.slice(0, Math.max(0, matches.length - 10))) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch {}
    }
  } catch {}
}

function writeIfChanged(file, before, after) {
  if (before === after) return "unchanged";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (exists(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(file, `${file}.bak-${stamp}`);
    pruneBackups(file);
  }
  const mode = exists(file) ? fs.statSync(file).mode & 0o777 : 0o644;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, after, { encoding: "utf-8", mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
  return "updated";
}

// ─── JSON MCP config ──────────────────────────────────────────────────

function isLegacy(entry) {
  return !!entry && LEGACY_COMMANDS.some(c => JSON.stringify(entry).includes(c));
}

/**
 * Registers the server under `key` ("mcpServers" or "mcp"). Keeps every other key.
 * `ensure` sets top-level keys the tool requires (e.g. Muse's schema_version),
 * but only when absent — a present value, even a newer one, is never overwritten.
 */
function withJsonServer(config, key, entry, ensure) {
  const next = JSON.parse(JSON.stringify(config));
  if (ensure) {
    for (const [k, v] of Object.entries(ensure)) {
      if (!(k in next)) next[k] = v;
    }
  }
  next[key] = next[key] && typeof next[key] === "object" && !Array.isArray(next[key]) ? next[key] : {};
  const current = next[key][SERVER_KEY];
  if (!current || isLegacy(current)) next[key][SERVER_KEY] = entry;
  return next;
}

function applyJsonMcp(file, key, entry, ensure) {
  const before = readJsonStrict(file);
  const after = withJsonServer(before, key, entry, ensure);
  if (JSON.stringify(before) === JSON.stringify(after)) return "unchanged";
  return writeIfChanged(file, readText(file), JSON.stringify(after, null, 2) + "\n");
}

// ─── TOML config (Codex CLI) ──────────────────────────────────────────

/** Hook events Codex fires that the protocol needs. Same names and payloads as Claude Code. */
const CODEX_HOOKS = [
  { event: "UserPromptSubmit", command: "user-prompt-submit" },
  { event: "PreToolUse", command: "pre-tool-use", matcher: "*" },
  { event: "PostToolUse", command: "post-tool-use", matcher: "*" },
  { event: "Stop", command: "stop" },
];

/**
 * The managed block: the MCP server and, when enabled, the enforcement hooks.
 * Each hook passes `--source codex` so the reply uses Codex's format.
 */
function tomlBlock(withHooks) {
  // Codex refuses MCP tool calls in non-interactive runs unless the server's tools are pre-approved.
  // Only this server is affected; it reads and writes the shared store on this machine.
  const lines = [TOML_START, `[mcp_servers.${SERVER_KEY}]`, `command = "${COMMAND}"`, `default_tools_approval_mode = "approve"`];
  if (withHooks) {
    for (const h of CODEX_HOOKS) {
      lines.push("", `[[hooks.${h.event}]]`);
      if (h.matcher) lines.push(`matcher = "${h.matcher}"`);
      lines.push(`[[hooks.${h.event}.hooks]]`, `type = "command"`);
      lines.push(`command = "${COMMAND} hook ${h.command} --source codex"`, `timeout = 10`);
    }
  }
  lines.push(TOML_END);
  return lines.join("\n");
}

/** Removes our managed block. Refuses if the user already has their own [mcp_servers.common-context]. */
function splitToml(text) {
  const start = text.indexOf(TOML_START);
  const end = text.indexOf(TOML_END);
  const inside = start !== -1 && end > start ? text.slice(start, end + TOML_END.length) : "";
  const outside = inside ? text.replace(inside, "") : text;
  const own = new RegExp(`^\\s*\\[mcp_servers\\.("?)${SERVER_KEY}\\1\\]`, "m");
  if (own.test(outside)) {
    throw new Error(`the Codex config already defines [mcp_servers.${SERVER_KEY}] outside the managed block; edit it by hand`);
  }
  return { outside, hasBlock: inside !== "" };
}

/**
 * Codex records its hook approvals as [hooks.state.*] tables with trusted_hash values. It may write
 * them inside our managed block, so they are kept and rewritten after the block. Dropping them would
 * make Codex ask for approval again.
 */
function preservedHookState(text) {
  const start = text.indexOf(TOML_START);
  const end = text.indexOf(TOML_END);
  if (start === -1 || end <= start) return [];
  const kept = [];
  let inState = false;
  for (const line of text.slice(start, end).split("\n")) {
    if (line.startsWith("[")) inState = line.startsWith("[hooks.state");
    if (inState && line.trim() !== "") kept.push(line.trim());
  }
  return kept;
}

/** Splits TOML lines into hook-approval tables ([hooks.state.*]) and everything else. */
function takeHookState(lines) {
  const state = [];
  const rest = [];
  let inState = false;
  for (const line of lines) {
    if (line.startsWith("[")) inState = line.startsWith("[hooks.state");
    if (inState && line.trim() !== "") state.push(line.trim());
    else if (!inState) rest.push(line);
  }
  return { state, rest };
}

function withTomlServer(text, { withHooks = false } = {}) {
  const { outside } = splitToml(text);
  // Approvals may sit inside the managed block or outside it, depending on who last wrote the file.
  const inside = preservedHookState(text);
  const outsideSplit = takeHookState(outside.split("\n"));
  const state = [...new Set([...inside, ...outsideSplit.state])];
  const base = outsideSplit.rest.join("\n").replace(/\s*$/, "");
  const stateBlock = state.length ? "\n" + state.join("\n") + "\n" : "";
  return (base ? base + "\n\n" : "") + tomlBlock(withHooks) + "\n" + stateBlock;
}

function applyTomlMcp(file, opts) {
  const before = readText(file);
  return writeIfChanged(file, before, withTomlServer(before, opts));
}

/** Codex loads AGENTS.override.md instead of AGENTS.md when it exists, so write where Codex reads. */
function codexRulesFile() {
  const override = path.join(codexHome(), "AGENTS.override.md");
  return exists(override) ? override : path.join(codexHome(), "AGENTS.md");
}

// ─── YAML config (Goose) ─────────────────────────────────────────────

const YAML_START = "# common-context:start";
const YAML_END = "# common-context:end";

const SERVER_BODY = {
  // extension key -> the indented lines under `common-context:`
  extensions: ["    name: common-context", `    cmd: ${COMMAND}`, "    args: []", "    enabled: true", "    envs: {}", "    type: stdio", "    timeout: 300"],
  mcp_servers: [`    command: ${COMMAND}`, "    args: []"],
};

const yamlBlock = topKey => [YAML_START, `  ${SERVER_KEY}:`, ...SERVER_BODY[topKey], YAML_END].join("\n");

/**
 * Adds the server under a top-level map (`extensions:` for Goose, `mcp_servers:` for Hermes) of a
 * YAML config as a managed block. The file is edited as text so every comment and key the user has
 * stays as it was. A block-style map is required; an inline one (`extensions: {}`) is refused
 * rather than guessed at.
 */
function withYamlServer(text, topKey) {
  const start = text.indexOf(YAML_START);
  const end = text.indexOf(YAML_END);
  let rest = text;
  if (start !== -1 && end > start) {
    const stop = text[end + YAML_END.length] === "\n" ? end + YAML_END.length + 1 : end + YAML_END.length;
    rest = text.slice(0, start) + text.slice(stop);
  }
  if (new RegExp(`^ {2}("?)${SERVER_KEY}\\1:`, "m").test(rest)) {
    throw new Error(`the config already defines a server named ${SERVER_KEY} outside the managed block; edit it by hand`);
  }
  const header = new RegExp(`^${topKey}:[ \\t]*(#.*)?$`, "m").exec(rest);
  if (header) {
    const at = header.index + header[0].length;
    return rest.slice(0, at) + "\n" + yamlBlock(topKey) + rest.slice(at);
  }
  if (new RegExp(`^${topKey}:`, "m").test(rest)) {
    throw new Error(`the config writes \`${topKey}:\` inline; add the common-context server by hand, see README`);
  }
  const body = rest.replace(/\s*$/, "");
  return (body ? body + "\n" : "") + `${topKey}:\n` + yamlBlock(topKey) + "\n";
}

const withGooseServer = text => withYamlServer(text, "extensions");
const withHermesServer = text => withYamlServer(text, "mcp_servers");

function applyYamlMcp(file, topKey) {
  const before = readText(file);
  return writeIfChanged(file, before, withYamlServer(before, topKey));
}

// ─── Kilo Code: rules are a list of files in the config's `instructions` key ───

function withInstruction(config, instructionFile) {
  const next = JSON.parse(JSON.stringify(config));
  const list = Array.isArray(next.instructions) ? next.instructions : [];
  if (next.instructions !== undefined && !Array.isArray(next.instructions)) {
    throw new Error('the Kilo config has an "instructions" value that is not a list; add the protocol file by hand');
  }
  if (!list.includes(instructionFile)) list.push(instructionFile);
  next.instructions = list;
  return next;
}

function applyKiloInstructions(file) {
  writeProtocolFile();
  const before = readJsonStrict(file);
  const after = withInstruction(before, PROTOCOL_FILE);
  if (JSON.stringify(before) === JSON.stringify(after)) return "unchanged";
  return writeIfChanged(file, readText(file), JSON.stringify(after, null, 2) + "\n");
}

// ─── Markdown rules / system prompt files ─────────────────────────────

const markdownBlock = () => `${MD_START}\n${PROTOCOL}\n${MD_END}`;

/** Replaces our block, or appends it. Text outside the markers is never touched. */
function upsertMarkdown(text) {
  // The protocol goes first, so the agent reads it before anything else in its rules file.
  // An existing block is moved to the top; the rest of the file is kept as it was.
  const start = text.indexOf(MD_START);
  const end = text.indexOf(MD_END);
  const rest = start !== -1 && end > start ? text.slice(0, start) + text.slice(end + MD_END.length) : text;
  const body = rest.replace(/^\s*/, "").replace(/\s*$/, "");
  return markdownBlock() + "\n" + (body ? "\n" + body + "\n" : "");
}

function applyRules(file) {
  const before = readText(file);
  return writeIfChanged(file, before, upsertMarkdown(before));
}

function writeProtocolFile() {
  return writeIfChanged(PROTOCOL_FILE, readText(PROTOCOL_FILE), `# common-context protocol\n\n${PROTOCOL}\n`);
}

// ─── Claude Code enforcement hooks ────────────────────────────────────

const CLAUDE_HOOKS = {
  UserPromptSubmit: { command: "user-prompt-submit" },
  PreToolUse: { command: "pre-tool-use", matcher: "*" },
  PostToolUse: { command: "post-tool-use", matcher: "*" },
  PostToolUseFailure: { command: "post-tool-use-failure", matcher: "*" },
  Stop: { command: "stop" },
};
const HOOK_MARKER = `${COMMAND} hook `;
const CLAUDE_SETTINGS = path.join(HOME, ".claude", "settings.json");

/** Adds our hook groups. Other hooks are kept; reruns replace only ours. */
function withClaudeHooks(settings) {
  const next = JSON.parse(JSON.stringify(settings));
  next.hooks = next.hooks && typeof next.hooks === "object" ? next.hooks : {};
  for (const [event, spec] of Object.entries(CLAUDE_HOOKS)) {
    const groups = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    const kept = groups.filter(g => !(g && Array.isArray(g.hooks) && g.hooks.some(h => h && typeof h.command === "string" && h.command.startsWith(HOOK_MARKER))));
    const group = { hooks: [{ type: "command", command: `${COMMAND} hook ${spec.command}`, timeout: 10 }] };
    if (spec.matcher) group.matcher = spec.matcher;
    next.hooks[event] = [...kept, group];
  }
  return next;
}

function applyClaudeHooks() {
  const before = readJsonStrict(CLAUDE_SETTINGS);
  const after = withClaudeHooks(before);
  if (JSON.stringify(before) === JSON.stringify(after)) return "unchanged";
  return writeIfChanged(CLAUDE_SETTINGS, readText(CLAUDE_SETTINGS), JSON.stringify(after, null, 2) + "\n");
}

// ─── Hooks for Cursor, Gemini CLI and OpenCode ─────────────────────────

const HOOK_MARK = `${COMMAND} hook `;
const isOurs = h => !!h && typeof h.command === "string" && h.command.startsWith(HOOK_MARK);
/** Groups that carry our command are dropped, so reruns never duplicate and the user's own hooks survive. */
// Handles both shapes: Cursor's flat entries ({command}) and nested groups ({hooks: [{command}]}).
const withoutOurs = groups => (Array.isArray(groups) ? groups : []).filter(g => !(isOurs(g) || (g && Array.isArray(g.hooks) && g.hooks.some(isOurs))));

/** Cursor: ~/.cursor/hooks.json. Event names and the `--source cursor` reply format are Cursor's. */
const CURSOR_EVENTS = {
  beforeSubmitPrompt: "user-prompt-submit",
  preToolUse: "pre-tool-use",
  postToolUse: "post-tool-use",
  postToolUseFailure: "post-tool-use-failure",
  stop: "stop",
};
const CURSOR_HOOKS = path.join(HOME, ".cursor", "hooks.json");

function withCursorHooks(config) {
  const next = JSON.parse(JSON.stringify(config));
  next.version = next.version ?? 1;
  next.hooks = next.hooks && typeof next.hooks === "object" ? next.hooks : {};
  for (const [event, cmd] of Object.entries(CURSOR_EVENTS)) {
    const kept = withoutOurs(next.hooks[event]);
    next.hooks[event] = [...kept, { command: `${COMMAND} hook ${cmd} --source cursor`, timeout: 10 }];
  }
  return next;
}

/** Gemini CLI: ~/.gemini/settings.json "hooks". Event names are Gemini's (BeforeAgent, BeforeTool, ...). */
const GEMINI_EVENTS = {
  BeforeAgent: "user-prompt-submit",
  BeforeTool: "pre-tool-use",
  AfterTool: "post-tool-use",
  AfterAgent: "stop",
};

function withGeminiHooks(settings) {
  const next = JSON.parse(JSON.stringify(settings));
  next.hooks = next.hooks && typeof next.hooks === "object" ? next.hooks : {};
  for (const [event, cmd] of Object.entries(GEMINI_EVENTS)) {
    const kept = withoutOurs(next.hooks[event]);
    next.hooks[event] = [...kept, { hooks: [{ name: "common-context", type: "command", command: `${COMMAND} hook ${cmd} --source gemini`, timeout: 10000 }] }];
  }
  return next;
}

/**
 * OpenCode has no JSON hooks; enforcement is a plugin. The plugin is a file we own
 * (marked below), so it is rewritten only when it is ours. A user's own file at the
 * same path is never overwritten.
 */
// OpenCode loads plugins from a subdirectory with an index.js. A bare common-context.js in the
// plugins folder was observed to hang OpenCode at startup.
const OPENCODE_PLUGIN = path.join(HOME, ".config", "opencode", "plugins", "common-context", "index.js");
const OPENCODE_PLUGIN_LEGACY = path.join(HOME, ".config", "opencode", "plugins", "common-context.js");
const OPENCODE_MARK = "// common-context-mcp managed plugin";

function openCodePlugin() {
  return `${OPENCODE_MARK} — regenerated by common-context-mcp-setup; edit at your own risk.
import { execFileSync } from "node:child_process";

// Runs the enforcement handler. Any failure allows the call and never blocks the agent by accident.
function run(event, payload) {
  try {
    const out = execFileSync("${COMMAND}", ["hook", event, "--source", "opencode"], {
      input: JSON.stringify(payload),
      encoding: "utf-8",
      timeout: 10000,
    });
    return JSON.parse(out || "{}");
  } catch {
    return {};
  }
}

// OpenCode loads a plugin from its default export: an id and a setup(context) function. Tool hooks
// are registered through context.tool.hook, which the @opencode/plugin types describe.
export default {
  id: "common-context",
  setup: async (ctx) => {
    const regs = [];
    regs.push(await ctx.tool.hook("execute.before", async (call) => {
      const decision = run("pre-tool-use", {
        session_id: call.sessionID,
        tool_name: call.tool,
        tool_input: call.input,
      });
      if (decision.decision === "deny") throw new Error(decision.reason);
    }));
    regs.push(await ctx.tool.hook("execute.after", async (call) => {
      run("post-tool-use", {
        session_id: call.sessionID,
        tool_name: call.tool,
        tool_input: call.input,
        tool_response: call.status === "completed" ? call.result : { error: call.error },
      });
    }));
    return async () => {
      for (const r of regs) await r.dispose();
    };
  },
};
`;
}

/** Writes a JSON hooks file (Cursor, Gemini) if the merged result differs. */
function applyJsonHooks(file, transform) {
  const before = readJsonStrict(file);
  const after = transform(before);
  if (JSON.stringify(before) === JSON.stringify(after)) return "unchanged";
  return writeIfChanged(file, readText(file), JSON.stringify(after, null, 2) + "\n");
}

function applyOpenCodePlugin() {
  const before = readText(OPENCODE_PLUGIN);
  if (before && !before.includes(OPENCODE_MARK)) {
    throw new Error(`${OPENCODE_PLUGIN} exists and is not managed by common-context; move it aside to enable OpenCode hooks`);
  }
  // Remove our earlier single-file install; leave any other file alone.
  const legacy = readText(OPENCODE_PLUGIN_LEGACY);
  if (legacy.includes(OPENCODE_MARK)) fs.unlinkSync(OPENCODE_PLUGIN_LEGACY);
  return writeIfChanged(OPENCODE_PLUGIN, before, openCodePlugin());
}

// ─── Locations that depend on what is installed ───────────────────────

const TOOL_NAMES = [
  "load_context", "save_context", "save_summary", "save_failure", "record_success", "search_context",
  "claim_area", "release_area", "list_claims", "broadcast", "handoff", "get_patterns",
  "get_audit_trail", "resume_session", "session_status",
];

/** Kilo reads kilo.jsonc or kilo.json from ~/.config/kilo. An existing file wins; a new one is plain JSON. */
function kiloConfig() {
  const dir = path.join(HOME, ".config", "kilo");
  for (const name of ["kilo.jsonc", "kilo.json"]) if (exists(path.join(dir, name))) return path.join(dir, name);
  return path.join(dir, "kilo.json");
}

/** Cline's VS Code extension keeps its settings in VS Code's global storage. */
function clineExtensionDir() {
  const code =
    process.platform === "darwin" ? path.join(HOME, "Library", "Application Support", "Code")
    : process.platform === "win32" ? path.join(process.env.APPDATA || path.join(HOME, "AppData", "Roaming"), "Code")
    : path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, ".config"), "Code");
  return path.join(code, "User", "globalStorage", "saoudrizwan.claude-dev");
}

/** Every Cline settings file that exists here: the CLI's and the VS Code extension's. The CLI's is the fallback. */
function clineSettingsFiles() {
  const cli = process.env.CLINE_MCP_SETTINGS_PATH || path.join(HOME, ".cline", "data", "settings", "cline_mcp_settings.json");
  const ext = path.join(clineExtensionDir(), "settings", "cline_mcp_settings.json");
  const files = [];
  if (exists(path.join(HOME, ".cline")) || which("cline") || process.env.CLINE_MCP_SETTINGS_PATH) files.push(cli);
  if (exists(clineExtensionDir())) files.push(ext);
  return files.length ? files : [cli];
}

/** Hermes keeps everything under HERMES_HOME, which defaults to ~/.hermes. */
const hermesHome = () => (process.env.HERMES_HOME && path.isAbsolute(process.env.HERMES_HOME.trim()) && process.env.HERMES_HOME.trim()) || path.join(HOME, ".hermes");

/** Zed keeps settings.json under ~/.config/zed on macOS/Linux and %APPDATA%\Zed on Windows. */
function zedSettingsFile() {
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(HOME, "AppData", "Roaming"), "Zed", "settings.json");
  return path.join(HOME, ".config", "zed", "settings.json");
}

/** Where a tool's MCP registration goes, for the setup listing. */
function describeTarget(agent) {
  if (agent.unsupported) return "not supported (no MCP client)";
  const m = agent.mcp;
  return m.files ? m.files().join(", ") : m.file;
}

// ─── Removal (uninstall) ────────────────────────────────────────────
// Every writer above has an inverse here. Inverses only remove what we wrote:
// user-owned entries, files and comments are left alone, and anything ambiguous
// is reported as manual instead of guessed at.

/** True when a JSON MCP entry is one we wrote (any of our shapes) or a legacy one. */
function isOurServer(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.command === COMMAND) return true;
  if (Array.isArray(entry.command) && entry.command.includes(COMMAND)) return true;
  return isLegacy(entry);
}

function removeJsonServer(config, key) {
  const next = JSON.parse(JSON.stringify(config));
  const group = next[key];
  if (!group || typeof group !== "object" || !(SERVER_KEY in group)) return { config: next, removed: false };
  if (!isOurServer(group[SERVER_KEY])) return { config: next, removed: false, custom: true };
  delete next[key][SERVER_KEY];
  return { config: next, removed: true };
}

function applyJsonUnmcp(file, key) {
  const before = readJsonStrict(file);
  const { config: after, removed, custom } = removeJsonServer(before, key);
  if (custom) return "manual";
  if (!removed) return "unchanged";
  return writeIfChanged(file, readText(file), JSON.stringify(after, null, 2) + "\n") === "updated" ? "removed" : "unchanged";
}

/** Strips our TOML block, preserving Codex's hook-approval tables wherever they sit. */
function withoutTomlServer(text) {
  const { outside } = splitToml(text); // still refuses user-owned blocks
  const inside = preservedHookState(text);
  const split = takeHookState(outside.split("\n"));
  const state = [...new Set([...inside, ...split.state])];
  const base = split.rest.join("\n").replace(/\s*$/, "");
  const parts = [];
  if (base) parts.push(base);
  if (state.length) parts.push(state.join("\n"));
  return parts.length ? parts.join("\n\n") + "\n" : "";
}

function applyTomlUnmcp(file) {
  const before = readText(file);
  if (!before.includes(TOML_START)) return "unchanged";
  return writeIfChanged(file, before, withoutTomlServer(before)) === "updated" ? "removed" : "unchanged";
}

/** Strips our YAML block; drops the top-level header too when its section is left empty. */
function withoutYamlServer(text, topKey) {
  const start = text.indexOf(YAML_START);
  const end = text.indexOf(YAML_END);
  let rest = text;
  if (start !== -1 && end > start) {
    const stop = text[end + YAML_END.length] === "\n" ? end + YAML_END.length + 1 : end + YAML_END.length;
    rest = text.slice(0, start) + text.slice(stop);
  }
  if (new RegExp(`^ {2}("?)${SERVER_KEY}\\1:`, "m").test(rest)) {
    throw new Error(`the config still defines a server named ${SERVER_KEY} outside the managed block; edit it by hand`);
  }
  const lines = rest.split("\n");
  const hi = lines.findIndex(l => new RegExp(`^${topKey}:[ \\t]*(#.*)?$`).test(l));
  if (hi !== -1 && new RegExp(`^${topKey}:[ \\t]*$`).test(lines[hi])) {
    let hasContent = false;
    for (let i = hi + 1; i < lines.length; i++) {
      if (lines[i].trim() === "") continue;
      if (/^[ \t]+\S/.test(lines[i])) hasContent = true;
      break;
    }
    if (!hasContent) lines.splice(hi, 1);
  }
  const out = lines.join("\n").replace(/\s*$/, "");
  return out ? out + "\n" : "";
}

function applyYamlUnmcp(file, topKey) {
  const before = readText(file);
  if (!before.includes(YAML_START)) return "unchanged";
  return writeIfChanged(file, before, withoutYamlServer(before, topKey)) === "updated" ? "removed" : "unchanged";
}

/** Removes our protocol block; the rest of the file is untouched. */
function withoutMarkdownBlock(text) {
  const start = text.indexOf(MD_START);
  const end = text.indexOf(MD_END);
  if (start === -1 || end <= start) return text;
  const rest = text.slice(0, start) + text.slice(end + MD_END.length);
  const body = rest.replace(/^\s*/, "").replace(/\s*$/, "");
  return body ? body + "\n" : "";
}

function applyRulesRemove(file) {
  const before = readText(file);
  if (!before.includes(MD_START)) return "unchanged";
  return writeIfChanged(file, before, withoutMarkdownBlock(before)) === "updated" ? "removed" : "unchanged";
}

function withoutInstruction(config, instructionFile) {
  const next = JSON.parse(JSON.stringify(config));
  if (!Array.isArray(next.instructions)) return next;
  next.instructions = next.instructions.filter(f => f !== instructionFile);
  if (next.instructions.length === 0) delete next.instructions;
  return next;
}

function applyKiloUninstructions(file) {
  const before = readJsonStrict(file);
  const after = withoutInstruction(before, PROTOCOL_FILE);
  if (JSON.stringify(before) === JSON.stringify(after)) return "unchanged";
  return writeIfChanged(file, readText(file), JSON.stringify(after, null, 2) + "\n") === "updated" ? "removed" : "unchanged";
}

/** Drops our hook entries; empty events (and an empty hooks object) go with them. */
function withoutJsonHooks(settings, events) {
  const next = JSON.parse(JSON.stringify(settings));
  if (!next.hooks || typeof next.hooks !== "object") return next;
  for (const event of Object.keys(events)) {
    if (!Array.isArray(next.hooks[event])) continue;
    next.hooks[event] = withoutOurs(next.hooks[event]);
    if (next.hooks[event].length === 0) delete next.hooks[event];
  }
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return next;
}

function applyJsonUnhooks(file, events) {
  const before = readJsonStrict(file);
  const after = withoutJsonHooks(before, events);
  if (JSON.stringify(before) === JSON.stringify(after)) return "unchanged";
  return writeIfChanged(file, readText(file), JSON.stringify(after, null, 2) + "\n") === "updated" ? "removed" : "unchanged";
}

/** Deletes the OpenCode plugin files, but only when they carry our mark. */
function removeOpenCodePlugin() {
  let removed = false;
  for (const f of [OPENCODE_PLUGIN, OPENCODE_PLUGIN_LEGACY]) {
    const text = readText(f);
    if (text && text.includes(OPENCODE_MARK)) {
      fs.unlinkSync(f);
      removed = true;
    }
  }
  try {
    fs.rmdirSync(path.dirname(OPENCODE_PLUGIN)); // drops our dir when empty; fails safe otherwise
  } catch {}
  return removed ? "removed" : "unchanged";
}

// ─── Registry ─────────────────────────────────────────────────────────

/**
 * Each entry:
 *   detect()   – is the tool installed here?
 *   mcp        – how to register the server ({kind:"json", file, key, entry, ensure?} | {kind:"toml", file})
 *   rules      – {file} or {resolve()} for the protocol file, or null when it must be added by hand
 *   manual     – instructions shown when `rules` is null
 *   hooks      – "claude" | "codex" when the tool supports enforcement hooks, else absent
 */
const AGENTS = [
  {
    id: "claude-code",
    name: "Claude Code",
    detect: () => exists(path.join(HOME, ".claude.json")) || exists(path.join(HOME, ".claude")) || which("claude"),
    mcp: { kind: "json", file: path.join(HOME, ".claude.json"), key: "mcpServers", entry: { command: COMMAND } },
    rules: { file: path.join(HOME, ".claude", "CLAUDE.md") },
    hooks: "claude",
  },
  {
    id: "cursor",
    name: "Cursor",
    detect: () => exists(path.join(HOME, ".cursor")) || which("cursor"),
    mcp: { kind: "json", file: path.join(HOME, ".cursor", "mcp.json"), key: "mcpServers", entry: { command: COMMAND } },
    rules: null,
    hooks: "cursor",
    manual: `Cursor's global User Rules can only be set in its settings. Open Cursor → Settings → Rules → User Rules and paste the contents of ${PROTOCOL_FILE}`,
  },
  {
    id: "codex",
    name: "Codex CLI",
    detect: () => exists(codexHome()) || which("codex"),
    mcp: { kind: "toml", file: path.join(codexHome(), "config.toml") },
    rules: { resolve: codexRulesFile },
    hooks: "codex",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    detect: () => exists(path.join(HOME, ".gemini")) || which("gemini"),
    mcp: { kind: "json", file: path.join(HOME, ".gemini", "settings.json"), key: "mcpServers", entry: { command: COMMAND } },
    rules: { file: path.join(HOME, ".gemini", "GEMINI.md") },
    hooks: "gemini",
  },
  {
    id: "opencode",
    name: "OpenCode",
    detect: () => exists(path.join(HOME, ".config", "opencode")) || which("opencode"),
    mcp: { kind: "json", file: path.join(HOME, ".config", "opencode", "opencode.json"), key: "mcp", entry: { type: "local", command: [COMMAND] } },
    rules: { file: path.join(HOME, ".config", "opencode", "AGENTS.md") },
    hooks: "opencode",
  },
  {
    id: "kilo",
    name: "Kilo Code",
    detect: () => exists(path.join(HOME, ".config", "kilo")) || exists(path.join(HOME, ".kilocode")) || which("kilo") || which("kilocode"),
    mcp: { kind: "json", files: () => [kiloConfig()], key: "mcp", entry: { type: "local", command: [COMMAND], enabled: true } },
    rules: { kind: "kilo", file: () => kiloConfig() },
  },
  {
    id: "cline",
    name: "Cline",
    detect: () => exists(path.join(HOME, ".cline")) || exists(clineExtensionDir()) || which("cline"),
    mcp: { kind: "json", files: clineSettingsFiles, key: "mcpServers", entry: { command: COMMAND, args: [], disabled: false, autoApprove: TOOL_NAMES } },
    rules: { file: path.join(HOME, "Documents", "Cline", "Rules", "common-context.md") },
  },
  {
    id: "goose",
    name: "Goose",
    detect: () => exists(path.join(HOME, ".config", "goose")) || which("goose"),
    mcp: { kind: "yaml", topKey: "extensions", file: path.join(HOME, ".config", "goose", "config.yaml") },
    rules: { file: path.join(HOME, ".config", "goose", ".goosehints") },
  },
  {
    id: "freebuff",
    name: "Freebuff",
    detect: () => exists(path.join(HOME, ".config", "manicode")) || exists(path.join(HOME, ".config", "freebuff")) || which("freebuff"),
    // Freebuff shares Codebuff's SDK: ~/.agents/mcp.json is read, and the schema is strict.
    mcp: { kind: "json", file: path.join(HOME, ".agents", "mcp.json"), key: "mcpServers", entry: { type: "stdio", command: COMMAND, args: [], env: {} } },
    // Its user-level instructions file is ~/.AGENTS.md (read before ~/.CLAUDE.md).
    rules: { file: path.join(HOME, ".AGENTS.md") },
  },
  {
    id: "hermes",
    name: "Hermes Agent",
    detect: () => exists(hermesHome()) || which("hermes"),
    mcp: { kind: "yaml", topKey: "mcp_servers", file: path.join(hermesHome(), "config.yaml") },
    // SOUL.md is Hermes's global identity file, read at every start. The block goes first.
    rules: { resolve: () => path.join(hermesHome(), "SOUL.md") },
  },
  {
    id: "muse",
    name: "Muse",
    detect: () => exists(path.join(HOME, ".config", "muse")) || which("muse"),
    // The key is snake_case `mcp_servers`; camelCase `mcpServers` is ignored. Per Meta's docs
    // each server needs `transport: "stdio"`, and the file needs `"schema_version": 1`.
    // `mode: "optional"` skips us with a warning instead of aborting the run when unavailable.
    mcp: { kind: "json", file: path.join(HOME, ".config", "muse", "settings.json"), key: "mcp_servers", entry: { transport: "stdio", command: COMMAND, args: [], mode: "optional" }, ensure: { schema_version: 1 } },
    rules: null,
    manual: `Muse Code documents no global rules file. In each project run \`muse init\`, then paste the contents of ${PROTOCOL_FILE} into its AGENTS.md`,
  },
  {
    id: "qwen",
    name: "Qwen Code",
    detect: () => exists(path.join(HOME, ".qwen")) || which("qwen"),
    mcp: { kind: "json", file: path.join(HOME, ".qwen", "settings.json"), key: "mcpServers", entry: { command: COMMAND } },
    rules: { file: path.join(HOME, ".qwen", "QWEN.md") },
  },
  {
    id: "zed",
    name: "Zed",
    detect: () => exists(path.dirname(zedSettingsFile())) || which("zed"),
    // Zed names the section `context_servers`, and `"source": "custom"` is mandatory:
    // without it Zed silently ignores the entry.
    mcp: { kind: "json", file: zedSettingsFile(), key: "context_servers", entry: { source: "custom", command: COMMAND, args: [], env: {} } },
    rules: null,
    manual: `Zed reads rules from each project's .rules directory. Create a .rules/common-context.md file in the project and paste the contents of ${PROTOCOL_FILE}`,
  },
  {
    id: "windsurf",
    name: "Windsurf",
    detect: () => exists(path.join(HOME, ".codeium")) || which("windsurf"),
    // Windsurf documents stdio servers as `command` plus `args`.
    mcp: { kind: "json", file: path.join(HOME, ".codeium", "windsurf", "mcp_config.json"), key: "mcpServers", entry: { command: COMMAND, args: [] } },
    rules: { file: path.join(HOME, ".codeium", "windsurf", "memories", "global_rules.md") },
  },
  {
    id: "kiro",
    name: "Kiro",
    detect: () => exists(path.join(HOME, ".kiro")) || which("kiro"),
    mcp: { kind: "json", file: path.join(HOME, ".kiro", "settings", "mcp.json"), key: "mcpServers", entry: { command: COMMAND } },
    // Kiro reads every Markdown file under ~/.kiro/steering as persistent instructions.
    rules: { file: path.join(HOME, ".kiro", "steering", "common-context.md") },
  },
  {
    id: "aider",
    name: "Aider",
    detect: () => exists(path.join(HOME, ".aider.conf.yml")) || which("aider"),
    mcp: null,
    rules: null,
    unsupported: "Aider has no MCP client, so it cannot call common-context tools. Nothing was written; use a tool that supports MCP.",
  },
];

/** Each hook-capable tool's installer. Codex's hooks are written with its MCP block, so it has none here. */
const HOOK_INSTALLERS = {
  claude: () => ({ label: "enforcement hooks", status: applyClaudeHooks(), path: CLAUDE_SETTINGS }),
  codex: () => null,
  cursor: () => ({ label: "enforcement hooks", status: applyJsonHooks(CURSOR_HOOKS, withCursorHooks), path: CURSOR_HOOKS }),
  gemini: () => ({ label: "enforcement hooks", status: applyJsonHooks(path.join(HOME, ".gemini", "settings.json"), withGeminiHooks), path: path.join(HOME, ".gemini", "settings.json") }),
  opencode: () => ({ label: "enforcement plugin", status: applyOpenCodePlugin(), path: OPENCODE_PLUGIN }),
};

/**
 * Applies one agent's MCP registration, rules and (if enabled) hooks.
 * Returns [{label, status, path}] where status is "updated" | "unchanged" | "manual".
 */
function configureAgent(agent, { enableHooks = false } = {}) {
  const results = [];
  if (agent.unsupported) return [{ label: "not supported", status: "manual", path: agent.unsupported }];
  const m = agent.mcp;
  if (m.kind === "json") {
    for (const file of m.files ? m.files() : [m.file]) {
      results.push({ label: "MCP server", status: applyJsonMcp(file, m.key, m.entry, m.ensure), path: file });
    }
  } else if (m.kind === "yaml") {
    results.push({ label: "MCP server", status: applyYamlMcp(m.file, m.topKey), path: m.file });
  } else {
    // Codex keeps its hooks in the same managed block as the MCP entry.
    const withHooks = enableHooks && agent.hooks === "codex";
    results.push({ label: withHooks ? "MCP server + hooks" : "MCP server", status: applyTomlMcp(m.file, { withHooks }), path: m.file });
  }

  if (agent.rules && agent.rules.kind === "kilo") {
    const file = agent.rules.file();
    results.push({ label: "protocol rules (instructions)", status: applyKiloInstructions(file), path: file });
  } else if (agent.rules) {
    const file = agent.rules.resolve ? agent.rules.resolve() : agent.rules.file;
    results.push({ label: "protocol rules", status: applyRules(file), path: file });
  } else {
    results.push({ label: "protocol rules", status: "manual", path: agent.manual });
  }

  if (enableHooks && agent.hooks) {
    const h = HOOK_INSTALLERS[agent.hooks]();
    if (h) results.push(h);
  }
  return results;
}

const HOOK_UNINSTALLERS = {
  claude: () => ({ label: "enforcement hooks", status: applyJsonUnhooks(CLAUDE_SETTINGS, CLAUDE_HOOKS), path: CLAUDE_SETTINGS }),
  codex: () => null,
  cursor: () => ({ label: "enforcement hooks", status: applyJsonUnhooks(CURSOR_HOOKS, CURSOR_EVENTS), path: CURSOR_HOOKS }),
  gemini: () => {
    const file = path.join(HOME, ".gemini", "settings.json");
    return { label: "enforcement hooks", status: applyJsonUnhooks(file, GEMINI_EVENTS), path: file };
  },
  opencode: () => ({ label: "enforcement plugin", status: removeOpenCodePlugin(), path: OPENCODE_PLUGIN }),
};

/**
 * Removes one agent's MCP registration, rules and hooks installed by configureAgent.
 * Returns [{label, status, path}] where status is "removed" | "unchanged" | "manual".
 * Backups (*.bak-*) and the shared PROTOCOL_FILE are always left alone.
 */
function unconfigureAgent(agent) {
  const results = [];
  if (agent.unsupported) return [{ label: "not supported", status: "manual", path: agent.unsupported }];
  const m = agent.mcp;
  if (m.kind === "json") {
    for (const file of m.files ? m.files() : [m.file]) {
      const status = applyJsonUnmcp(file, m.key);
      results.push({
        label: "MCP server",
        status,
        path: status === "manual" ? `${file} defines its own ${SERVER_KEY} entry; left alone` : file,
      });
    }
  } else if (m.kind === "yaml") {
    results.push({ label: "MCP server", status: applyYamlUnmcp(m.file, m.topKey), path: m.file });
  } else {
    results.push({ label: "MCP server + hooks", status: applyTomlUnmcp(m.file), path: m.file });
  }

  if (agent.rules && agent.rules.kind === "kilo") {
    const file = agent.rules.file();
    results.push({ label: "protocol rules (instructions)", status: applyKiloUninstructions(file), path: file });
  } else if (agent.rules) {
    const file = agent.rules.resolve ? agent.rules.resolve() : agent.rules.file;
    results.push({ label: "protocol rules", status: applyRulesRemove(file), path: file });
  } else {
    results.push({ label: "protocol rules", status: "manual", path: agent.manual });
  }

  if (agent.hooks) {
    const h = HOOK_UNINSTALLERS[agent.hooks]();
    if (h) results.push(h);
  }
  return results;
}

module.exports = {
  AGENTS,
  PROTOCOL,
  PROTOCOL_FILE,
  CLAUDE_SETTINGS,
  SERVER_KEY,
  COMMAND,
  configureAgent,
  unconfigureAgent,
  removeJsonServer,
  withoutTomlServer,
  withoutYamlServer,
  withoutMarkdownBlock,
  withoutInstruction,
  withoutJsonHooks,
  removeOpenCodePlugin,
  pruneBackups,
  writeProtocolFile,
  withJsonServer,
  withTomlServer,
  splitToml,
  upsertMarkdown,
  withClaudeHooks,
  codexHome,
  codexRulesFile,
  withCursorHooks,
  withGeminiHooks,
  withGooseServer,
  withHermesServer,
  hermesHome,
  withInstruction,
  describeTarget,
  kiloConfig,
  clineSettingsFiles,
  TOOL_NAMES,
  openCodePlugin,
  CURSOR_HOOKS,
  OPENCODE_PLUGIN,
};
