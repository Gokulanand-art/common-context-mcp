import type { ContextData, SessionEntry } from "./store.js";

/**
 * What load_context shows an agent. The brief view is the default: it stays inside a character
 * budget so a large store does not cost the agent a large prompt on every session. The full view
 * is the complete picture, for debugging, and is requested with detail: "full".
 */
export type Detail = "brief" | "full";

export interface RenderOptions {
  /** Identity of the agent reading the store. */
  agentId: string;
  /** A session whose heartbeat is older than this is treated as dead. */
  staleMs: number;
  detail: Detail;
  /** Brief view only: the most characters it may produce. */
  budgetChars: number;
}

/** Cuts text to n characters, marking the cut. */
export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A short window of text around the first match of q, for search results. */
export function excerpt(text: string, q: string, n: number): string {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return clip(text, n);
  const start = Math.max(0, i - Math.floor(n / 3));
  const body = text.slice(start, start + n);
  return `${start > 0 ? "…" : ""}${body}${start + n < text.length ? "…" : ""}`;
}

const isStale = (s: SessionEntry, t: number, staleMs: number) => t - Date.parse(s.heartbeat) > staleMs;
const isLive = (s: SessionEntry, t: number, staleMs: number) =>
  (s.status === "active" || s.status === "checkpointed") && !isStale(s, t, staleMs);

export function renderLoad(d: ContextData, currentId: string | null, o: RenderOptions): string {
  return o.detail === "full" ? renderFull(d, currentId, o) : renderBrief(d, currentId, o);
}

/** Brief view: the newest items of each kind, clipped, in priority order, within the budget. */
function renderBrief(d: ContextData, currentId: string | null, o: RenderOptions): string {
  const t = Date.now();
  const head = [
    "=== SHARED CONTEXT (brief; load_context with detail \"full\" for everything) ===",
    `Your session: ${currentId ?? "(none)"} (agent ${o.agentId})`,
    `Sessions: ${d.sessions.length} | Failures: ${d.failures.length} | Context entries: ${Object.keys(d.contexts).length}`,
  ];

  // Ordered by priority: when the budget runs out, the sections at the end are the ones dropped.
  const sections: string[][] = [];

  const live = d.sessions
    .filter(s => s.id !== currentId && s.agent !== o.agentId && isLive(s, t, o.staleMs))
    .slice(0, 5);
  if (live.length > 0) {
    sections.push(["ACTIVE IN OTHER AGENTS (check list_claims before editing shared files):",
      ...live.map(s => `  [${s.id}] ${clip(s.title, 80)} by ${s.agent}`)]);
  }

  const interrupted = d.sessions.filter(s => s.status === "interrupted").slice(-3);
  if (interrupted.length > 0) {
    sections.push(["INTERRUPTED SESSIONS (resume_session(id) to continue):",
      ...interrupted.map(s => `  [${s.id}] "${clip(s.title, 60)}" by ${s.agent}: ${clip(s.checkpoint || s.accomplished || "none", 160)} | next: ${clip(s.next_steps || "none", 120)}`)]);
  }

  const ctx = Object.entries(d.contexts)
    .sort((a, b) => b[1].updated.localeCompare(a[1].updated))
    .slice(0, 10);
  if (ctx.length > 0) {
    sections.push(["CONTEXT (newest 10):", ...ctx.map(([k, e]) => `[${k}] ${clip(e.value, 160)}`)]);
  }

  const recent = d.sessions.slice(-3);
  if (recent.length > 0) {
    sections.push(["RECENT SESSIONS:", ...recent.flatMap(s => {
      const lines = [`[${s.id}] ${clip(s.title, 80)} (${s.status}) ${clip(s.accomplished || "", 200)}`];
      if (s.next_steps) lines.push(`  next: ${clip(s.next_steps, 150)}`);
      return lines;
    })]);
  }

  const fails = d.failures.slice(-5);
  if (fails.length > 0) {
    sections.push(["FAILURES (do not repeat):", ...fails.map(f => `[${clip(f.approach, 160)}] ${clip(f.why_failed, 120)}`)]);
  }

  const claims = Object.entries(d.claims).filter(([, c]) => Date.parse(c.expires) > t).slice(0, 5);
  if (claims.length > 0) {
    sections.push(["CLAIMED AREAS:", ...claims.map(([a, c]) => `${a} → ${c.agent}`)]);
  }

  const bc = d.broadcasts.slice(-3);
  if (bc.length > 0) {
    sections.push(["BROADCASTS:", ...bc.map(b => `[${b.agent}] ${clip(b.message, 160)}`)]);
  }

  const out = [...head];
  let used = out.join("\n").length;
  for (let i = 0; i < sections.length; i++) {
    const block = ["", ...sections[i]].join("\n");
    if (used + block.length > o.budgetChars) {
      const dropped = sections.length - i;
      out.push("", `… ${dropped} section(s) omitted to stay within the budget. Use search_context, get_audit_trail, or load_context with detail "full".`);
      break;
    }
    out.push(...["", ...sections[i]]);
    used += block.length;
  }
  out.push("", "You now have the shared knowledge you need. Proceed with your work.");
  return out.join("\n");
}

/** Full view: everything in the store, as before brief was added. For debugging. */
function renderFull(d: ContextData, currentId: string | null, o: RenderOptions): string {
  const t = Date.now();
  const out: string[] = [];
  out.push("=== SHARED CONTEXT LOADED ===");
  out.push(`Your session: ${currentId ?? "(none)"} (agent ${o.agentId})`);
  out.push(`Sessions: ${d.sessions.length} | Failures: ${d.failures.length} | Context entries: ${Object.keys(d.contexts).length}`);
  out.push(`Patterns: ${d.patterns.works.length} work, ${d.patterns.fails.length} fail`);
  out.push("");

  const live = d.sessions.filter(s => s.id !== currentId && s.agent !== o.agentId && isLive(s, t, o.staleMs));
  if (live.length > 0) {
    out.push("⏳ ACTIVE IN OTHER AGENTS (do not duplicate; check list_claims):");
    for (const s of live) out.push(`  [${s.id}] "${s.title}" by ${s.agent} (heartbeat ${s.heartbeat})`);
    out.push("");
  }

  const interrupted = d.sessions.filter(s => s.status === "interrupted").slice(-10);
  if (interrupted.length > 0) {
    out.push("⚠️ INTERRUPTED SESSIONS (resume_session(session_id) to continue one):");
    for (const s of interrupted) {
      out.push(`  [${s.id}] "${s.title}" by ${s.agent}`);
      out.push(`  Last checkpoint: ${s.checkpoint || s.accomplished || "none"}`);
      out.push(`  Next steps: ${s.next_steps || "none"}`);
      out.push(`  Interrupted at: ${s.interrupted_at || s.timestamp}`);
      out.push("");
    }
  }

  const ctxEntries = Object.entries(d.contexts).sort((a, b) => b[1].updated.localeCompare(a[1].updated));
  if (ctxEntries.length > 0) {
    out.push("--- CONTEXT ENTRIES ---");
    for (const [key, e] of ctxEntries.slice(0, 100)) {
      out.push(`[${key}] ${e.value} (tags: ${e.tags.join(", ")}) [by ${e.agent}]`);
    }
    if (ctxEntries.length > 100) out.push(`...${ctxEntries.length - 100} older entries omitted; use search_context.`);
    out.push("");
  }

  if (d.sessions.length > 0) {
    out.push("--- SESSION HISTORY (most recent) ---");
    for (const s of d.sessions.slice(-20)) {
      out.push(`[${s.id}] ${s.title} (${s.status}) by ${s.agent} at ${s.timestamp}`);
      if (s.accomplished) out.push(`  Accomplished: ${s.accomplished}`);
      if (s.learned) out.push(`  Learned: ${s.learned}`);
      if (s.decisions) out.push(`  Decisions: ${s.decisions}`);
      if (s.next_steps) out.push(`  Next steps: ${s.next_steps}`);
      if (s.checkpoint) out.push(`  Checkpoint: ${s.checkpoint}`);
    }
    out.push("");
  }

  if (d.failures.length > 0) {
    out.push("--- FAILURE RECORDS (DO NOT REPEAT) ---");
    for (const f of d.failures.slice(-50)) out.push(`[${f.approach}] ${f.why_failed} (by ${f.agent}, ${f.timestamp})`);
    out.push("");
  }

  if (d.broadcasts.length > 0) {
    out.push("--- BROADCASTS (most recent) ---");
    for (const b of d.broadcasts.slice(-20)) out.push(`[${b.agent}] ${b.message} (${b.timestamp})`);
    out.push("");
  }

  if (d.patterns.works.length > 0 || d.patterns.fails.length > 0) {
    out.push("--- PATTERNS ---");
    if (d.patterns.works.length > 0) out.push(`Works: ${d.patterns.works.join(", ")}`);
    if (d.patterns.fails.length > 0) out.push(`Fails: ${d.patterns.fails.join(", ")}`);
    out.push("");
  }

  const claims = Object.entries(d.claims).filter(([, c]) => Date.parse(c.expires) > t);
  if (claims.length > 0) {
    out.push("--- ACTIVE CLAIMS ---");
    for (const [area, c] of claims) out.push(`${area} → claimed by ${c.agent} (since ${c.since})`);
    out.push("");
  }

  out.push("=== END OF CONTEXT ===");
  out.push("You now have full shared knowledge. Proceed with your work.");
  return out.join("\n");
}
