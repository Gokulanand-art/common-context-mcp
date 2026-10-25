import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "./config.js";
import { ContextStore, type ContextData } from "./store.js";

/**
 * Enforcement hooks for the AI tools that support them. The protocol is:
 *
 *   user message  – the agent must call a common-context tool before any other tool
 *   after a tool  – a failure is recorded in the shared store, and the agent must
 *                   search it before trying an alternative
 *   final answer  – when work was done, save_summary must run first
 *
 * Each tool sends different JSON and expects a different reply. The handlers
 * work with a neutral decision (Decision below); render() converts it into the
 * format of the tool that asked. Supported sources:
 *
 *   claude-code, codex  – PreToolUse/PostToolUse/Stop style (same format)
 *   cursor              – conversation_id, permission deny, followup_message
 *   gemini, opencode    – decision deny/block, reason, hookSpecificOutput
 *
 * Hooks never throw. An internal error is shown to the user and the event is
 * allowed through, so a broken hook cannot lock a session. CONTEXT_MCP_ENFORCE=0
 * turns enforcement off.
 */

export type Source = "claude-code" | "codex" | "cursor" | "gemini" | "opencode";
const SOURCES: Source[] = ["claude-code", "codex", "cursor", "gemini", "opencode"];

const MCP_PREFIX = "mcp__common-context__";
const STATE_DIR = path.join(os.homedir(), ".claude", "state", "common-context");
const MAX_STOP_BLOCKS = 2;

/** Tools this server exposes. Used to recognise our calls under any tool-naming scheme. */
const KNOWN_TOOLS = new Set([
  "load_context", "search_context", "save_context", "save_summary", "save_failure",
  "record_success", "claim_area", "release_area", "list_claims", "broadcast",
  "handoff", "get_patterns", "get_audit_trail", "resume_session", "session_status",
]);

/** The tool's own name for our server, whatever it prefixes: mcp__common-context__x, mcp__common_context__x, common-context_x. */
export function mcpName(tool: string): string | null {
  // Codex sanitises the server name, so its tools are mcp__common_context__<tool>.
  const m = /common[-_]context[_.:-]+([a-z_]+)$/.exec(tool ?? "");
  return m && KNOWN_TOOLS.has(m[1]) ? m[1] : null;
}

/**
 * OpenCode reaches MCP tools through a generic `execute` tool (code such as
 * tools["common-context"].load_context()) or a `search` tool with a namespace. Those calls count
 * as ours when their input names this server and one of its tools.
 */
const WRAPPER_TOOLS = new Set(["execute", "search"]);
export function wrappedMcpName(tool: string, toolInput: unknown): string | null {
  if (!WRAPPER_TOOLS.has(tool)) return null;
  const text = typeof toolInput === "string" ? toolInput : JSON.stringify(toolInput ?? "");
  if (!/common[-_]context/.test(text)) return null;
  const m = /\b(load_context|search_context|save_context|save_summary|save_failure|record_success|claim_area|release_area|list_claims|broadcast|handoff|get_patterns|get_audit_trail|resume_session|session_status)\b/.exec(text);
  return m ? m[1] : null;
}

/** Full name used in the protocol text, for messages to the agent. */
const full = (name: string) => `${MCP_PREFIX}${name}`;

interface PendingError {
  tool: string;
  message: string;
  at: string;
}

interface State {
  loaded: boolean;
  mcpSession: string | null;
  mcpSincePrompt: boolean;
  workSincePrompt: boolean;
  summarizedSincePrompt: boolean;
  pendingError: PendingError | null;
  stopBlocks: number;
}

/** What a handler wants to say. render() turns it into the caller's format. */
export interface Decision {
  systemMessage?: string;
  /** Text added to the agent's context for this turn. */
  context?: string;
  /** Refuse the tool call, with this reason. */
  deny?: string;
  /** Keep the agent working instead of finishing, with this reason. */
  block?: string;
}

interface Input {
  session_id?: string;
  conversation_id?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: any;
  tool_output?: unknown;
  error?: unknown;
  prompt?: string;
  prompt_response?: string;
  stop_hook_active?: boolean;
  loop_count?: number;
  last_assistant_message?: string;
}

interface Ctx {
  sid: string;
  source: Source;
}

const emptyState = (): State => ({
  loaded: false,
  mcpSession: null,
  mcpSincePrompt: false,
  workSincePrompt: false,
  summarizedSincePrompt: false,
  pendingError: null,
  stopBlocks: 0,
});

const enforcing = () => process.env.CONTEXT_MCP_ENFORCE !== "0";
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Masks common credential shapes before anything is written to the shared store. */
export function redact(s: string): string {
  return s
    .replace(/(authorization:\s*)(bearer|basic)\s+\S+/gi, "$1$2 [REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/g, "Bearer [REDACTED]")
    .replace(/\b(sk|pk|ghp|gho|ghs|xox[abprs])[-_][A-Za-z0-9_-]{12,}/g, "[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
    .replace(/((?:api[_-]?key|token|secret|password|passwd|pwd)\s*[=:]\s*)("?)[^\s"&,;]+/gi, "$1$2[REDACTED]");
}

function text(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function statePath(sid: string): string {
  return path.join(STATE_DIR, `${sid.replace(/[^\w-]/g, "_")}.json`);
}

function readState(sid: string): State {
  try {
    return { ...emptyState(), ...JSON.parse(fs.readFileSync(statePath(sid), "utf-8")) };
  } catch {
    return emptyState();
  }
}

function writeState(sid: string, s: State): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const p = statePath(sid);
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  fs.renameSync(tmp, p);
}

function storeFor(ctx: Ctx): ContextStore {
  // Records are attributed to the tool and session that caused them.
  return new ContextStore(loadConfig({ ...process.env, CONTEXT_MCP_AGENT_ID: `${ctx.source}:${ctx.sid}` }));
}

/** Input is normalised so every source looks the same to the handlers. */
function ctxOf(input: Input, source: Source): Ctx {
  return { sid: input.session_id ?? input.conversation_id ?? "unknown", source };
}

/** A failed tool result, or null. Covers Claude/Codex (is_error, exit_code), Gemini (error) and Cursor (tool_output). */
function resultFailed(input: Input): string | null {
  const r = input.tool_response;
  if (r && typeof r === "object") {
    if (r.is_error === true) return text(r) || "tool reported an error";
    if (r.error) return text(r.error);
    const code = r.exit_code ?? r.exitCode;
    if (typeof code === "number" && code !== 0) return `exit code ${code}: ${text(r)}`;
  }
  const out = input.tool_output;
  if (typeof out === "string") {
    const m = /"exit_code"\s*:\s*(-?\d+)/.exec(out);
    if (m && m[1] !== "0") return `exit code ${m[1]}: ${clip(out, 500)}`;
  }
  return null;
}

function recordFailure(ctx: Ctx, state: State, input: Input, message: string): Decision {
  const tool = input.tool_name ?? "unknown tool";
  const approach = redact(clip(`${tool}: ${text(input.tool_input)}`, 500));
  const why = redact(clip(message || "unknown error", 1000));
  const timestamp = new Date().toISOString();

  storeFor(ctx).write((d: ContextData) => {
    d.failures.push({ approach, why_failed: why, agent: `${ctx.source}:${ctx.sid}`, timestamp });
    if (!d.patterns.fails.includes(approach)) d.patterns.fails.push(approach);
    const s = d.sessions.find(x => x.id === state.mcpSession);
    if (s && s.status !== "completed") {
      s.status = "checkpointed";
      s.checkpoint = `Failed: ${clip(approach, 200)} → ${clip(why, 200)}`;
      s.heartbeat = timestamp;
    }
  });

  state.pendingError = { tool, message: clip(why, 300), at: timestamp };
  state.workSincePrompt = true;
  return {
    systemMessage: `⚠️ common-context: error recorded in the shared store (${tool}: ${clip(why, 120)}). Next: call ${full("search_context")} for related records before any alternative approach.`,
    context: `The error was recorded in the shared store. Call ${full("search_context")} with keywords from it before trying an alternative approach.`,
  };
}

function briefing(ctx: Ctx): string {
  try {
    const { interrupted, open } = storeFor(ctx).read((d: ContextData) => ({
      interrupted: d.sessions.filter(s => s.status === "interrupted").map(s => s.id),
      open: d.sessions.filter(s => s.status === "active" || s.status === "checkpointed").length,
    }));
    const parts = [`open sessions: ${open}`];
    if (interrupted.length) parts.push(`interrupted (resumable): ${interrupted.slice(-3).join(", ")}`);
    return parts.join("; ");
  } catch (e) {
    return `store unavailable (${(e as Error).message})`;
  }
}

const PROTOCOL = `common-context protocol (enforced by hooks):
1. Before any other tool for this message, call ${full("load_context")} (first message of a session) or ${full("search_context")}.
2. Call ${full("save_context")} after each meaningful step (this is the checkpoint).
3. On any error, ${full("save_failure")} is recorded automatically; call ${full("search_context")} before trying an alternative.
4. Before your final answer, call ${full("save_summary")} with what was done, learned, decided and next steps.`;

// ─── handlers ─────────────────────────────────────────────────────────

export function onUserPromptSubmit(input: Input, ctx: Ctx): Decision {
  const state = readState(ctx.sid);
  state.mcpSincePrompt = false;
  state.workSincePrompt = false;
  state.summarizedSincePrompt = false;
  state.stopBlocks = 0;
  writeState(ctx.sid, state);
  const status = state.loaded ? `session ${state.mcpSession ?? "loaded"}` : "not loaded — load_context required";
  return {
    systemMessage: `🧠 common-context: protocol active for this message (${status}; ${briefing(ctx)})`,
    context: PROTOCOL,
  };
}

export function onPreToolUse(input: Input, ctx: Ctx): Decision {
  if (!enforcing()) return {};
  const tool = input.tool_name ?? "";
  // ToolSearch loads the MCP tool schemas, so it must stay reachable or the gate deadlocks.
  if (mcpName(tool) !== null || wrappedMcpName(tool, input.tool_input) !== null || tool === "ToolSearch") return {};
  const state = readState(ctx.sid);

  let reason: string | null = null;
  if (!state.loaded) {
    reason = `Call ${full("load_context")} before any work. It is required at the start of every session.`;
  } else if (!state.mcpSincePrompt) {
    reason = `Call ${full("load_context")} or ${full("search_context")} for this message before using ${tool}.`;
  } else if (state.pendingError) {
    reason = `Error just occurred: ${state.pendingError.message}. Call ${full("search_context")} for related records before any alternative approach.`;
  }
  if (!reason) return {};
  return { systemMessage: `⛔ common-context: ${tool} blocked — ${reason}`, deny: reason };
}

export function onPostToolUse(input: Input, ctx: Ctx): Decision {
  const tool = input.tool_name ?? "";
  const state = readState(ctx.sid);
  const name = mcpName(tool) ?? wrappedMcpName(tool, input.tool_input);

  if (name !== null) {
    state.mcpSincePrompt = true;
    let note = "";
    if (name === "load_context") {
      state.loaded = true;
      const m = /Your session: (session-\d+)/.exec(text(input.tool_response ?? input.tool_output));
      if (m) state.mcpSession = m[1];
      note = state.mcpSession ? ` (${state.mcpSession})` : "";
    }
    if (name === "save_summary") state.summarizedSincePrompt = true;
    if (name === "search_context" || name === "save_failure") state.pendingError = null;
    writeState(ctx.sid, state);
    return { systemMessage: `✓ common-context: ${name}${note}` };
  }

  const failure = resultFailed(input);
  if (failure) {
    const out = recordFailure(ctx, state, input, failure);
    writeState(ctx.sid, state);
    return out;
  }
  state.workSincePrompt = true;
  writeState(ctx.sid, state);
  return {};
}

export function onPostToolUseFailure(input: Input, ctx: Ctx): Decision {
  const tool = input.tool_name ?? "";
  const state = readState(ctx.sid);
  if (mcpName(tool) !== null) {
    state.mcpSincePrompt = true;
    writeState(ctx.sid, state);
    return { systemMessage: `✗ common-context: ${mcpName(tool)} failed: ${clip(text(input.error ?? "unknown error"), 200)}` };
  }
  const out = recordFailure(ctx, state, input, text(input.error ?? "tool failed"));
  writeState(ctx.sid, state);
  return out;
}

export function onStop(input: Input, ctx: Ctx): Decision {
  if (!enforcing()) return {};
  const state = readState(ctx.sid);

  const problems: string[] = [];
  if (!state.mcpSincePrompt) {
    problems.push(`Before answering, call ${full("search_context")} (or ${full("load_context")}) for this message.`);
  }
  const needsSummary = state.workSincePrompt && !state.summarizedSincePrompt;
  if (needsSummary) {
    problems.push(`Before your final answer, call ${full("save_summary")} with accomplished, learned, decisions and next_steps.`);
  }

  if (problems.length === 0) {
    state.stopBlocks = 0;
    writeState(ctx.sid, state);
    return {
      systemMessage: state.summarizedSincePrompt
        ? "✅ common-context: work recorded and summary saved."
        : "✅ common-context: MCP called for this message.",
    };
  }

  const exhausted = !!input.stop_hook_active || (input.loop_count ?? 0) > 0 || state.stopBlocks >= MAX_STOP_BLOCKS;
  if (exhausted) {
    // The agent has had its chances. Record what we can so nothing is silently lost.
    if (needsSummary) {
      const at = new Date().toISOString();
      const accomplished = redact(clip(input.last_assistant_message ?? input.prompt_response ?? "(no final message)", 4000));
      storeFor(ctx).write((d: ContextData) => {
        const existing = d.sessions.find(x => x.id === state.mcpSession);
        if (existing && existing.status !== "completed") {
          Object.assign(existing, {
            status: "completed",
            accomplished,
            checkpoint: "Summary recorded automatically by hook",
            ended_at: at,
            heartbeat: at,
          });
        } else {
          d.sessions.push({
            id: `auto-${at.replace(/\D/g, "").slice(0, 14)}`,
            title: "Session (auto-summary)",
            status: "completed",
            accomplished,
            learned: "",
            decisions: "",
            next_steps: "",
            checkpoint: "Summary recorded automatically by hook",
            agent: `${ctx.source}:${ctx.sid}`,
            timestamp: at,
            heartbeat: at,
            ended_at: at,
          });
        }
      });
      state.summarizedSincePrompt = true;
    }
    state.stopBlocks = 0;
    writeState(ctx.sid, state);
    return {
      systemMessage: `⚠️ common-context: stopped without ${needsSummary ? "save_summary" : "MCP"}; ${needsSummary ? "a summary was recorded automatically" : "nothing else recorded"}.`,
    };
  }

  state.stopBlocks += 1;
  writeState(ctx.sid, state);
  const reason = problems.join(" ");
  return { systemMessage: `⏸ common-context: final answer held — ${reason}`, block: reason };
}

// ─── rendering: neutral decision → the caller's format ─────────────────

const CLAUDE_EVENT: Record<string, string> = {
  "user-prompt-submit": "UserPromptSubmit",
  "pre-tool-use": "PreToolUse",
  "post-tool-use": "PostToolUse",
  "post-tool-use-failure": "PostToolUseFailure",
  stop: "Stop",
};

function render(source: Source, event: string, d: Decision): Record<string, unknown> {
  const hookEventName = CLAUDE_EVENT[event] ?? event;
  switch (source) {
    case "claude-code":
    case "codex": {
      const out: Record<string, unknown> = {};
      if (d.systemMessage) out.systemMessage = d.systemMessage;
      if (d.deny) {
        out.hookSpecificOutput = { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: d.deny };
      } else if (d.block) {
        out.decision = "block";
        out.reason = d.block;
      } else if (d.context) {
        out.hookSpecificOutput = { hookEventName, additionalContext: d.context };
      }
      return out;
    }
    case "cursor": {
      const out: Record<string, unknown> = {};
      if (d.systemMessage) out.user_message = d.systemMessage;
      if (d.deny) {
        out.permission = "deny";
        out.agent_message = d.deny;
      } else if (d.block) {
        out.followup_message = d.block;
      } else if (d.context) {
        out.continue = true;
        out.agent_message = d.context;
      }
      return out;
    }
    case "gemini":
    case "opencode": {
      const out: Record<string, unknown> = {};
      if (d.systemMessage) out.systemMessage = d.systemMessage;
      if (d.deny) {
        out.decision = "deny";
        out.reason = d.deny;
      } else if (d.block) {
        out.decision = "block";
        out.reason = d.block;
      } else if (d.context) {
        out.hookSpecificOutput = { hookEventName, additionalContext: d.context };
      }
      return out;
    }
  }
}

const HANDLERS: Record<string, (input: Input, ctx: Ctx) => Decision> = {
  "user-prompt-submit": onUserPromptSubmit,
  "pre-tool-use": onPreToolUse,
  "post-tool-use": onPostToolUse,
  "post-tool-use-failure": onPostToolUseFailure,
  stop: onStop,
};

/** Accepts Claude's names (PostToolUse) and the kebab-case form (post-tool-use). */
function canonicalEvent(event: string | undefined): string | undefined {
  return event?.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** Reads `--source <name>`, then CONTEXT_MCP_HOOK_SOURCE, then defaults to Claude Code. */
export function sourceFrom(argv: string[], env: NodeJS.ProcessEnv = process.env): Source {
  const i = argv.indexOf("--source");
  const value = (i >= 0 ? argv[i + 1] : undefined) || env.CONTEXT_MCP_HOOK_SOURCE || "claude-code";
  return SOURCES.includes(value as Source) ? (value as Source) : "claude-code";
}

/** Entry point for `common-context-mcp hook <event> [--source <tool>]`. Reads the event JSON from stdin. */
export function runHook(event: string | undefined, argv: string[] = process.argv): Promise<void> {
  return new Promise(resolve => {
    const source = sourceFrom(argv);
    let raw = "";
    try {
      raw = fs.readFileSync(0, "utf-8");
    } catch {
      raw = "";
    }
    let out: Record<string, unknown>;
    try {
      const key = canonicalEvent(event);
      const handler = key ? HANDLERS[key] : undefined;
      if (!handler || !key) throw new Error(`unknown hook event "${event}"`);
      const input = (raw.trim() ? JSON.parse(raw) : {}) as Input;
      const decision = handler(input, ctxOf(input, source));
      out = render(source, key, decision);
    } catch (e) {
      // Fail open, but never silently: the user sees that enforcement was skipped.
      out = render(source, "", { systemMessage: `⚠️ common-context hook error (${event}): ${(e as Error).message}. Enforcement skipped for this event.` });
    }
    process.stdout.write(JSON.stringify(out) + "\n", () => resolve());
  });
}
