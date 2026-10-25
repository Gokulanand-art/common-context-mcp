import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadConfig, STORE_FILE_NAME, type Config } from "./config.js";
import {
  ContextStore,
  SCHEMA_VERSION,
  appendArchive,
  splitArchive,
  type ContextData,
  type SessionEntry,
} from "./store.js";
import { excerpt, renderLoad, type Detail } from "./render.js";
import { redact } from "./redact.js";
import { log } from "./log.js";

// eslint-disable-next-line @typescript-eslint/no-var-requires
export const VERSION: string = (require("../package.json") as { version: string }).version;
export const SERVER_NAME = "common-context";

export const INSTRUCTIONS = `common-context protocol (mandatory, every message, including greetings):
1. Before any other tool or reply, call load_context (first message of a session) or search_context.
2. After each meaningful step, call save_context. This is the checkpoint.
3. On a failure, call save_failure, then search_context before any alternative.
4. Before editing a shared file, call claim_area; call release_area when done.
5. Before the final answer: save_context with the final state, then save_summary. Give the final answer only after both succeed.
Every tool except load_context requires load_context first in this session.`;

// Caps keep load_context useful as the store grows. Older items stay in the
// store and are reachable through search_context and get_audit_trail.
const LIMITS = {
  load: { contexts: 100, sessions: 20, failures: 50, broadcasts: 20 },
  audit: 200,
  search: 50,
};

const MAX_TEXT = 20_000;
// Write-time caps. Longer text is clipped, not rejected, so a save never fails on length.
const CAP = { accomplished: 1_500, notes: 800, checkpoint: 300, value: 4_000 } as const;
const SHORT = 200;
const MED = 2_000;

type ToolResult = CallToolResult;
const ok = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
const fail = (t: string): ToolResult => ({ content: [{ type: "text", text: t }], isError: true });

const now = () => new Date().toISOString();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

function nextId(data: ContextData, prefix: string): string {
  let max = 0;
  for (const s of data.sessions) {
    const m = new RegExp(`^${prefix}-(\\d+)$`).exec(s.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${max + 1}`;
}

export function createServer(initial: Config = loadConfig()): McpServer {
  // The store follows the project folder the agent is working in. The folder comes from the client's
  // workspace roots before each tool call; without roots it is the folder the server started in.
  // CONTEXT_MCP_FILE, when set, pins the store file and ignores folder changes.
  const pinnedFile = Boolean(process.env.CONTEXT_MCP_FILE?.trim());
  const launchDir = process.env.CONTEXT_MCP_PROJECT_DIR?.trim() || process.cwd();
  let config: Config = initial;
  let store = new ContextStore(config);
  let projectDir: string | null = null;
  const me = initial.agentId;
  const state = { loaded: false, completed: false, sessionId: null as string | null };

  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION },
    { instructions: INSTRUCTIONS }
  );

  const cap = (t: string) =>
    t.length <= config.maxOutputChars
      ? t
      : `${t.slice(0, config.maxOutputChars)}\n\n...[truncated at ${config.maxOutputChars} chars; use search_context or get_audit_trail for specific items]`;

  const isStale = (s: SessionEntry, t: number) => t - Date.parse(s.heartbeat) > config.staleMs;
  const isLive = (s: SessionEntry, t: number) =>
    (s.status === "active" || s.status === "checkpointed") && !isStale(s, t);

  /** Records a checkpoint on this process's current session, if it still exists and is open. */
  function checkpoint(d: ContextData, note: string): void {
    const s = d.sessions.find(x => x.id === state.sessionId);
    if (!s || s.status === "completed") return;
    s.checkpoint = note;
    s.status = "checkpointed";
    s.heartbeat = now();
  }

  /** Points the store at a folder. A different folder starts a new session: the agent must load it again. */
  function bindProject(dir: string): void {
    if (dir === projectDir) return;
    projectDir = dir;
    config = { ...initial, file: path.join(dir, STORE_FILE_NAME) };
    store = new ContextStore(config);
    state.loaded = false;
    state.completed = false;
    state.sessionId = null;
    log.info(`project: ${dir} (store: ${config.file})`);
  }

  /** The first file:// workspace root the client reports, or null. */
  async function clientRoot(): Promise<string | null> {
    const caps = server.server.getClientCapabilities();
    if (!caps?.roots) return null;
    try {
      const res = await Promise.race([
        server.server.listRoots(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("roots/list timed out")), 2000)),
      ]);
      const root = res.roots.find(r => r.uri.startsWith("file://"));
      return root ? fileURLToPath(root.uri) : null;
    } catch (e) {
      log.warn(`could not read roots: ${(e as Error).message}`);
      return null;
    }
  }

  /** Before every tool call: follow the project folder the client is in. */
  async function syncProject(): Promise<void> {
    if (pinnedFile) return;
    bindProject((await clientRoot()) ?? launchDir);
  }

  function register<S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    handler: (args: z.output<z.ZodObject<S>>) => ToolResult,
    opts: { readOnly?: boolean; requiresLoad?: boolean } = {}
  ): void {
    const requiresLoad = opts.requiresLoad !== false;
    server.registerTool(
      name,
      {
        description,
        inputSchema: shape,
        annotations: { readOnlyHint: opts.readOnly === true },
      },
      // The SDK's callback type is a conditional on the shape, which cannot be
      // resolved inside this generic helper; the shape is validated by the SDK.
      (async (args: any): Promise<CallToolResult> => {
        try {
          await syncProject();
          if (requiresLoad && !state.loaded) {
            return fail("ERROR: You must call load_context() first before using any other tool. This is MANDATORY.");
          }
          return handler(args);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log.error(`${name} failed: ${msg}`);
          return fail(`ERROR in ${name}: ${msg}`);
        }
      }) as any
    );
  }

  // ─── load_context ─────────────────────────────────────────
  register(
    "load_context",
    "Start a session and load shared context: other agents' work, recent sessions, failures to avoid. Brief by default.",
    {
      detail: z.enum(["brief", "full"]).optional().describe("brief (default) or full, which is everything in the store"),
    },
    ({ detail }) => {
      const mode: Detail = detail === "full" ? "full" : "brief";
      if (state.loaded && state.sessionId) {
        // Already loaded in this process: re-read without starting a second session.
        return ok(cap(store.read(d => view(d, state.sessionId, mode))));
      }
      const text = store.write(d => {
        const t = Date.now();
        for (const s of d.sessions) {
          if ((s.status === "active" || s.status === "checkpointed") && isStale(s, t)) {
            s.status = "interrupted";
            s.interrupted_at = now();
            if (!s.checkpoint) {
              s.checkpoint = "Session ended without save_summary. Last save_context was the last checkpoint.";
            }
          }
        }
        for (const [area, claim] of Object.entries(d.claims)) {
          if (Date.parse(claim.expires) <= t) delete d.claims[area];
        }
        const id = nextId(d, "session");
        d.sessions.push({
          id,
          title: "In progress...",
          status: "active",
          accomplished: "",
          learned: "",
          decisions: "",
          next_steps: "",
          checkpoint: "Session started",
          agent: me,
          timestamp: now(),
          heartbeat: now(),
        });
        state.sessionId = id;
        // Old sessions and failures leave the live store for the archive file; nothing is deleted.
        const moved = splitArchive(d, {
          keepSessions: config.archiveSessions,
          days: config.archiveDays,
          keepId: id,
          now: t,
        });
        appendArchive(config.file, moved.sessions, moved.failures);
        return view(d, id, mode);
      });
      state.loaded = true;
      state.completed = false;
      return ok(cap(text));
    },
    { requiresLoad: false, readOnly: false }
  );

  /** The load view for the current project store. */
  function view(d: ContextData, currentId: string | null, detail: Detail): string {
    return renderLoad(d, currentId, { agentId: me, staleMs: config.staleMs, detail, budgetChars: config.loadBudgetChars });
  }

  // ─── save_context ─────────────────────────────────────────
  register(
    "save_context",
    "Save a fact, decision or config under a key. This is the checkpoint. Overwriting keeps the old value in history.",
    {
      key: z.string().min(1).max(SHORT).describe("Unique key for this context entry"),
      value: z.string().max(MAX_TEXT).describe("The value/content to store"),
      tags: z.array(z.string().max(50)).max(20).optional().describe("Tags for categorization"),
    },
    ({ key, value: raw, tags }) => {
      const value = redact(clip(raw, CAP.value));
      store.write(d => {
        const prev = d.contexts[key];
        d.contexts[key] = {
          value,
          tags: tags ?? [],
          agent: me,
          updated: now(),
          history: prev
            ? [...prev.history, { value: prev.value, agent: prev.agent, updated: prev.updated }]
            : [],
        };
        checkpoint(d, `Last saved: ${key} = ${clip(value, 200)}`);
      });
      return ok(`Saved context: ${key} = ${clip(value, 200)} (checkpoint recorded)`);
    }
  );

  // ─── save_summary ─────────────────────────────────────────
  register(
    "save_summary",
    "Save session summary at end of work. MANDATORY before giving final response. Marks session as complete.",
    {
      title: z.string().min(1).max(SHORT).describe("Session title"),
      accomplished: z.string().max(MAX_TEXT).describe("What was accomplished"),
      // Optional so a summary is never lost to a missing field. Agents often omit these.
      learned: z.string().max(MAX_TEXT).optional().describe("What was learned (optional)"),
      decisions: z.string().max(MAX_TEXT).optional().describe("Key decisions made (optional)"),
      next_steps: z.string().max(MAX_TEXT).optional().describe("Next steps for future agents (optional)"),
    },
    ({ title, accomplished: acc, learned: l = "", decisions: dec = "", next_steps: next = "" }) => {
      const accomplished = redact(clip(acc, CAP.accomplished));
      const learned = redact(clip(l, CAP.notes));
      const decisions = redact(clip(dec, CAP.notes));
      const next_steps = redact(clip(next, CAP.notes));
      store.write(d => {
        let s = d.sessions.find(x => x.id === state.sessionId);
        if (!s) {
          s = {
            id: nextId(d, "session"),
            title,
            status: "completed",
            accomplished: "",
            learned: "",
            decisions: "",
            next_steps: "",
            checkpoint: "",
            agent: me,
            timestamp: now(),
            heartbeat: now(),
          };
          d.sessions.push(s);
          state.sessionId = s.id;
        }
        Object.assign(s, {
          title,
          status: "completed" as const,
          accomplished,
          learned,
          decisions,
          next_steps,
          checkpoint: "Session completed",
          heartbeat: now(),
          ended_at: now(),
        });
      });
      state.completed = true;
      return ok("Session summary saved. You may now give your final response to the user.");
    }
  );

  // ─── save_failure ─────────────────────────────────────────
  register(
    "save_failure",
    "Record a failed approach IMMEDIATELY when something doesn't work.",
    {
      approach: z.string().min(1).max(MED).describe("What was attempted"),
      why_failed: z.string().min(1).max(MED).describe("Why it failed"),
    },
    ({ approach: a, why_failed: w }) => {
      const approach = redact(clip(a, MED));
      const why_failed = redact(clip(w, MED));
      store.write(d => {
        d.failures.push({ approach, why_failed, agent: me, timestamp: now() });
        if (!d.patterns.fails.includes(approach)) d.patterns.fails.push(approach);
        checkpoint(d, `Failed: ${clip(approach, 200)} → ${clip(why_failed, 200)}`);
      });
      return ok(`Failure recorded: ${approach} → ${why_failed}. Next agent will see this.`);
    }
  );

  // ─── record_success ───────────────────────────────────────
  register(
    "record_success",
    "Record an approach that worked, so future agents prefer it.",
    {
      approach: z.string().min(1).max(MED).describe("The approach that worked"),
    },
    ({ approach }) => {
      store.write(d => {
        if (!d.patterns.works.includes(approach)) d.patterns.works.push(approach);
        checkpoint(d, `Worked: ${clip(approach, 200)}`);
      });
      return ok(`Success recorded: ${approach}`);
    }
  );

  // ─── search_context ───────────────────────────────────────
  register(
    "search_context",
    "Search shared context by keyword. Returns short excerpts with ids; use get_audit_trail or load_context detail \"full\" for more.",
    {
      query: z.string().min(1).max(SHORT).describe("Search query"),
      limit: z.number().int().min(1).max(25).optional().describe("Most results to return (default 8)"),
    },
    ({ query, limit }) => {
      const q = query.toLowerCase();
      const has = (...fields: (string | undefined)[]) =>
        fields.some(f => (f ?? "").toLowerCase().includes(q));
      const pick = (...fields: (string | undefined)[]) =>
        fields.find(f => (f ?? "").toLowerCase().includes(q)) ?? "";

      const results = store.read(d => {
        const out: string[] = [];
        for (const [key, e] of Object.entries(d.contexts)) {
          if (has(key, e.value, ...e.tags)) out.push(`[context:${key}] ${excerpt(e.value, q, 220)}`);
        }
        for (const s of d.sessions) {
          if (has(s.title, s.accomplished, s.learned, s.decisions, s.next_steps, s.checkpoint)) {
            const text = pick(s.accomplished, s.learned, s.decisions, s.next_steps, s.checkpoint, s.title);
            out.push(`[session:${s.id}] ${s.title} (${s.status}): ${excerpt(text, q, 220)}`);
          }
        }
        for (const f of d.failures) {
          if (has(f.approach, f.why_failed)) out.push(`[failure] ${excerpt(pick(f.approach, f.why_failed), q, 220)}`);
        }
        for (const b of d.broadcasts) {
          if (has(b.message)) out.push(`[broadcast] ${excerpt(b.message, q, 220)}`);
        }
        return out;
      });

      if (results.length === 0) return ok(`No results found for "${query}".`);
      const shown = results.slice(0, limit ?? 8);
      const more = results.length > shown.length ? `\n...${results.length - shown.length} more; narrow the query or raise limit.` : "";
      return ok(`Found ${results.length} results:\n${shown.join("\n")}${more}`);
    },
    { readOnly: true }
  );

  // ─── claim_area ───────────────────────────────────────────
  register(
    "claim_area",
    "Claim a file or area so other agents avoid it. Expires after CONTEXT_MCP_CLAIM_MINUTES (default 30).",
    {
      area: z.string().min(1).max(500).describe("File path or area to claim"),
    },
    ({ area }) => {
      const message = store.write(d => {
        const t = Date.now();
        const existing = d.claims[area];
        if (existing && existing.agent !== me && Date.parse(existing.expires) > t) {
          return `Area ${area} is already claimed by ${existing.agent} since ${existing.since}. Choose a different area.`;
        }
        d.claims[area] = {
          agent: me,
          since: existing && existing.agent === me ? existing.since : now(),
          expires: new Date(t + config.claimMs).toISOString(),
        };
        return `Claimed: ${area}. Other agents will see this until it expires or is released.`;
      });
      return ok(message);
    }
  );

  // ─── release_area ─────────────────────────────────────────
  register(
    "release_area",
    "Release a claimed area.",
    {
      area: z.string().min(1).max(500).describe("File path or area to release"),
    },
    ({ area }) => {
      const released = store.write(d => {
        const c = d.claims[area];
        if (c && c.agent === me) {
          delete d.claims[area];
          return true;
        }
        return false;
      });
      return ok(released ? `Released: ${area}` : `Area ${area} was not claimed by you.`);
    }
  );

  // ─── list_claims ──────────────────────────────────────────
  register(
    "list_claims",
    "List all currently active (unexpired) area claims.",
    {},
    () => {
      const lines = store.read(d => {
        const t = Date.now();
        return Object.entries(d.claims)
          .filter(([, c]) => Date.parse(c.expires) > t)
          .map(([area, c]) => `${area} → ${c.agent} (since ${c.since})`);
      });
      if (lines.length === 0) return ok("No areas currently claimed.");
      return ok(`Active claims:\n${lines.join("\n")}`);
    },
    { readOnly: true }
  );

  // ─── broadcast ────────────────────────────────────────────
  register(
    "broadcast",
    "Broadcast a decision/message to all agents.",
    {
      message: z.string().min(1).max(MAX_TEXT).describe("Message to broadcast to all agents"),
    },
    ({ message }) => {
      store.write(d => {
        d.broadcasts.push({ message, agent: me, timestamp: now() });
        checkpoint(d, `Broadcast: ${clip(message, 200)}`);
      });
      return ok(`Broadcast sent: ${message}`);
    }
  );

  // ─── handoff ──────────────────────────────────────────────
  register(
    "handoff",
    "Transfer work to another agent with full context. Records a completed handoff session and a broadcast.",
    {
      to_agent: z.string().min(1).max(SHORT).describe("Target agent identifier"),
      summary: z.string().min(1).max(MED).describe("What's being handed off"),
      context: z.string().max(MAX_TEXT).describe("Full context for the receiving agent"),
    },
    ({ to_agent, summary, context }) => {
      store.write(d => {
        const t = now();
        d.sessions.push({
          id: nextId(d, "handoff"),
          title: `Handoff to ${to_agent}: ${summary}`,
          status: "completed",
          accomplished: context,
          learned: "",
          decisions: summary,
          next_steps: `Continue from: ${summary}`,
          checkpoint: "Handoff complete",
          agent: me,
          timestamp: t,
          heartbeat: t,
          ended_at: t,
        });
        d.broadcasts.push({ message: `HANDOFF to ${to_agent}: ${summary}`, agent: me, timestamp: t });
      });
      return ok(`Handoff recorded for ${to_agent}. Context saved for next agent.`);
    }
  );

  // ─── get_patterns ─────────────────────────────────────────
  register(
    "get_patterns",
    "Get learned patterns (what works and what fails).",
    {},
    () => {
      const d = store.read(x => x);
      const lines = [
        "=== LEARNED PATTERNS ===",
        `Works: ${d.patterns.works.length > 0 ? d.patterns.works.join(", ") : "(none yet)"}`,
        `Fails: ${d.patterns.fails.length > 0 ? d.patterns.fails.join(", ") : "(none yet)"}`,
        "",
        `Total failures recorded: ${d.failures.length}`,
        `Total sessions: ${d.sessions.length}`,
      ];
      return ok(lines.join("\n"));
    },
    { readOnly: true }
  );

  // ─── get_audit_trail ──────────────────────────────────────
  register(
    "get_audit_trail",
    "Get the audit trail of sessions, failures and claims (most recent first, capped).",
    {},
    () => {
      const d = store.read(x => x);
      const out: string[] = [
        "=== AUDIT TRAIL ===",
        `Store: ${config.file} (schema v${SCHEMA_VERSION})`,
        `Created: ${d.created}`,
        `Context entries: ${Object.keys(d.contexts).length}`,
        `Sessions: ${d.sessions.length}`,
        `Failures: ${d.failures.length}`,
        `Broadcasts: ${d.broadcasts.length}`,
        `Claims: ${Object.keys(d.claims).length}`,
        "",
      ];
      const sessions = [...d.sessions].reverse().slice(0, LIMITS.audit);
      if (sessions.length > 0) {
        out.push("--- SESSIONS ---");
        for (const s of sessions) out.push(`[${s.id}] ${s.title} (${s.status}) by ${s.agent} at ${s.timestamp}`);
        out.push("");
      }
      const failures = [...d.failures].reverse().slice(0, LIMITS.audit);
      if (failures.length > 0) {
        out.push("--- FAILURES ---");
        for (const f of failures) out.push(`[${f.approach}] ${f.why_failed} by ${f.agent} at ${f.timestamp}`);
        out.push("");
      }
      return ok(cap(out.join("\n")));
    },
    { readOnly: true }
  );

  // ─── resume_session ───────────────────────────────────────
  register(
    "resume_session",
    "Take over an interrupted session under this agent. Refuses completed sessions and ones another live agent is using.",
    {
      session_id: z.string().min(1).max(SHORT).describe("Session ID to resume (from load_context output)"),
    },
    ({ session_id }) => {
      const result = store.write(d => {
        const t = Date.now();
        const s = d.sessions.find(x => x.id === session_id);
        if (!s) return { ok: false as const, msg: `Session ${session_id} not found.` };
        if (s.status === "completed") {
          return { ok: false as const, msg: `Session ${session_id} is completed and cannot be resumed. Start a new session instead.` };
        }
        if (s.agent !== me && isLive(s, t)) {
          return { ok: false as const, msg: `Session ${session_id} is still live on agent ${s.agent} (heartbeat ${s.heartbeat}). Coordinate with it via broadcast() first.` };
        }
        // This process should have only one open session; close the previous one as interrupted.
        const prev = d.sessions.find(x => x.id === state.sessionId);
        if (prev && prev.id !== s.id && prev.status !== "completed") {
          prev.status = "interrupted";
          prev.interrupted_at = now();
          prev.checkpoint = prev.checkpoint || `Handed over to ${s.id}`;
        }
        s.status = "active";
        s.agent = me;
        s.heartbeat = now();
        s.checkpoint = `Resumed at ${now()}`;
        state.sessionId = s.id;
        return {
          ok: true as const,
          lines: [
            `=== RESUMING SESSION: ${s.title} ===`,
            `Session: ${s.id}`,
            `Accomplished so far: ${s.accomplished || "(nothing recorded)"}`,
            `Learned so far: ${s.learned || "(nothing recorded)"}`,
            `Decisions so far: ${s.decisions || "(nothing recorded)"}`,
            `Next steps: ${s.next_steps || "(nothing recorded)"}`,
            "",
            "Continue from where the previous agent left off.",
          ],
        };
      });
      state.completed = false;
      return result.ok ? ok(result.lines.join("\n")) : fail(result.msg);
    }
  );

  // ─── session_status ───────────────────────────────────────
  register(
    "session_status",
    "Store health: size, counts, interrupted sessions, estimated tokens of context.",
    {},
    () => {
      const { data, bytes } = store.read(d => ({ data: d, bytes: store.sizeBytes() }));
      const json = JSON.stringify(data);
      const estimatedTokens = Math.ceil(json.length / 4);
      const interrupted = data.sessions.filter(s => s.status === "interrupted").length;

      const lines = [
        "=== SESSION STATUS ===",
        `Server: common-context ${VERSION}`,
        `Store: ${config.file}`,
        `Store file size: ${bytes} bytes (schema v${SCHEMA_VERSION})`,
        `Sessions: ${data.sessions.length}`,
        `Failures: ${data.failures.length}`,
        `Context entries: ${Object.keys(data.contexts).length}`,
        `Broadcasts: ${data.broadcasts.length}`,
        `Agent ID: ${me}`,
        `Session loaded: ${state.loaded}`,
        `Session completed: ${state.completed}`,
        "",
        `Estimated store size in tokens: ~${estimatedTokens}`,
      ];
      if (interrupted > 0) lines.push(`⚠️ ${interrupted} interrupted session(s) need attention`);
      if (estimatedTokens > 50_000) lines.push("⚠️ Store is large: load_context shows only the most recent items; use search_context for the rest.");
      return ok(lines.join("\n"));
    },
    { readOnly: true }
  );

  return server;
}
