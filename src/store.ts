import { log } from "./log.js";
import * as fs from "node:fs";
import { schedulePush } from "./google.js";
import * as path from "node:path";
import type { Config } from "./config.js";

/**
 * Schema history:
 *   1 — original format (no heartbeat, no history)
 *   2 — adds session heartbeat/ended_at, context history
 */
export const SCHEMA_VERSION = 2;

export interface HistoryEntry {
  value: string;
  agent: string;
  updated: string;
}

export interface ContextEntry {
  value: string;
  tags: string[];
  agent: string;
  updated: string;
  history: HistoryEntry[];
}

export type SessionStatus = "active" | "checkpointed" | "completed" | "interrupted";

export interface SessionEntry {
  id: string;
  title: string;
  status: SessionStatus;
  accomplished: string;
  learned: string;
  decisions: string;
  next_steps: string;
  checkpoint: string;
  agent: string;
  timestamp: string;
  /** Last time the owning agent wrote anything. Used to detect dead sessions. */
  heartbeat: string;
  ended_at?: string;
  interrupted_at?: string;
}

export interface FailureEntry {
  approach: string;
  why_failed: string;
  agent: string;
  timestamp: string;
}

export interface ClaimEntry {
  agent: string;
  since: string;
  expires: string;
}

export interface BroadcastEntry {
  message: string;
  agent: string;
  timestamp: string;
}

export interface ContextData {
  version: number;
  created: string;
  contexts: Record<string, ContextEntry>;
  sessions: SessionEntry[];
  failures: FailureEntry[];
  claims: Record<string, ClaimEntry>;
  broadcasts: BroadcastEntry[];
  patterns: { works: string[]; fails: string[] };
}

export class StoreError extends Error {}

function emptyData(): ContextData {
  return {
    version: SCHEMA_VERSION,
    created: new Date().toISOString(),
    contexts: {},
    sessions: [],
    failures: [],
    claims: {},
    broadcasts: [],
    patterns: { works: [], fails: [] },
  };
}

/** Accepts any older schema and fills in fields it did not have. */
function normalize(raw: unknown): ContextData {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new StoreError("store file is not a JSON object");
  }
  const r = raw as Record<string, any>;
  const version = typeof r.version === "number" ? r.version : 1;
  if (version > SCHEMA_VERSION) {
    throw new StoreError(
      `store schema v${version} is newer than this server (v${SCHEMA_VERSION}); upgrade common-context-mcp`
    );
  }
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  const obj = <T>(v: unknown): Record<string, T> =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, T>) : {};

  const contexts = obj<ContextEntry>(r.contexts);
  for (const c of Object.values(contexts)) {
    c.tags = arr<string>(c.tags);
    c.history = arr<HistoryEntry>(c.history);
  }

  const sessions = arr<SessionEntry>(r.sessions);
  for (const s of sessions) {
    s.heartbeat = s.heartbeat || s.timestamp || new Date().toISOString();
    s.checkpoint = s.checkpoint ?? "";
  }

  return {
    version: SCHEMA_VERSION,
    created: r.created || new Date().toISOString(),
    contexts,
    sessions,
    failures: arr<FailureEntry>(r.failures),
    claims: obj<ClaimEntry>(r.claims),
    broadcasts: arr<BroadcastEntry>(r.broadcasts),
    patterns: {
      works: arr<string>(r.patterns?.works),
      fails: arr<string>(r.patterns?.fails),
    },
  };
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function timeMs(iso: string | undefined): number {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? t : 0;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Canonical form: key order no longer matters, so fingerprints compare by content alone. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = canonical((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

/** Stable fingerprint of a store: equal content gives equal strings on every machine. */
export function fingerprint(d: ContextData): string {
  return JSON.stringify(canonical(d));
}

/**
 * Picks the entry with the later timestamp. Ties break by smaller canonical form, so every
 * machine deterministically picks the same winner and repeated merges converge.
 */
function laterWins<T>(a: T, ta: number, b: T, tb: number): [winner: T, loser: T] {
  if (ta !== tb) return ta > tb ? [a, b] : [b, a];
  return JSON.stringify(canonical(a)) <= JSON.stringify(canonical(b)) ? [a, b] : [b, a];
}

function unionBy<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const k = key(it);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(clone(it));
    }
  }
  return out;
}

/** Completed and interrupted are terminal: a stale open copy must never resurrect them. */
function statusRank(s: SessionEntry): number {
  return s.status === "completed" ? 2 : s.status === "interrupted" ? 1 : 0;
}

/**
 * Merges two stores (local + Drive remote) without losing entries. Neither input is mutated.
 *
 *   contexts   — union by key; on conflict the later `updated` wins and the loser's value is
 *                kept in history, so no text is lost. Tags are unioned.
 *   sessions   — union by id; the same session (same agent + timestamp) resolves to the more
 *                terminal status, then the later heartbeat. An id collision between different
 *                sessions (both machines created `session-1`) keeps both, renaming the remote one.
 *   failures, broadcasts — union, deduped, oldest first.
 *   claims     — union by area; on conflict the later expiry wins.
 *   patterns   — union, local order first.
 *
 * Merge is idempotent and convergent: re-merging seen content changes nothing, so machines
 * settle instead of ping-ponging pushes at each other. (Array order may differ by merge
 * direction; content does not. Each side is stable under re-merge.)
 */
export function mergeData(local: ContextData, remote: unknown): ContextData {
  const a = normalize(clone(local));
  const b = normalize(clone(remote));

  const contexts: Record<string, ContextEntry> = {};
  for (const key of new Set([...Object.keys(a.contexts), ...Object.keys(b.contexts)])) {
    const x = a.contexts[key];
    const y = b.contexts[key];
    if (!x) {
      contexts[key] = clone(y);
      continue;
    }
    if (!y) {
      contexts[key] = clone(x);
      continue;
    }
    const [win, lose] = laterWins(x, timeMs(x.updated), y, timeMs(y.updated));
    const history = unionBy(
      [...win.history, ...lose.history],
      h => JSON.stringify([h.value, h.agent, h.updated])
    );
    if (lose.value !== win.value || lose.agent !== win.agent || lose.updated !== win.updated) {
      const entry = { value: lose.value, agent: lose.agent, updated: lose.updated };
      if (!history.some(h => h.value === entry.value && h.agent === entry.agent && h.updated === entry.updated)) {
        history.push(entry);
      }
    }
    contexts[key] = {
      value: win.value,
      tags: [...new Set([...x.tags, ...y.tags])],
      agent: win.agent,
      updated: win.updated,
      history,
    };
  }

  const sessionsById = new Map<string, SessionEntry>();
  for (const s of a.sessions) sessionsById.set(s.id, clone(s));
  const takeId = (id: string): string => {
    if (!sessionsById.has(id)) return id;
    const m = /^(.*)-(\d+)$/.exec(id);
    const prefix = m ? m[1] : id;
    let n = m ? Number(m[2]) + 1 : 2;
    while (sessionsById.has(`${prefix}-${n}`)) n++;
    return `${prefix}-${n}`;
  };
  for (const r of b.sessions) {
    const cur = sessionsById.get(r.id);
    if (!cur) {
      sessionsById.set(r.id, clone(r));
      continue;
    }
    if (cur.agent === r.agent && cur.timestamp === r.timestamp) {
      const ra = statusRank(cur);
      const rb = statusRank(r);
      const winner = ra !== rb ? (ra > rb ? cur : r) : laterWins(cur, timeMs(cur.heartbeat), r, timeMs(r.heartbeat))[0];
      const loser = winner === cur ? r : cur;
      const mergedSession = clone(winner);
      if (!mergedSession.checkpoint && loser.checkpoint) mergedSession.checkpoint = loser.checkpoint;
      sessionsById.set(r.id, mergedSession);
    } else {
      const renamed = clone(r);
      renamed.id = takeId(r.id);
      sessionsById.set(renamed.id, renamed);
    }
  }

  const byTime = (x: { timestamp: string }, y: { timestamp: string }) => timeMs(x.timestamp) - timeMs(y.timestamp);
  const failures = unionBy(
    [...a.failures, ...b.failures],
    f => JSON.stringify([f.approach, f.why_failed, f.agent, f.timestamp])
  ).sort(byTime);
  const broadcasts = unionBy(
    [...a.broadcasts, ...b.broadcasts],
    m => JSON.stringify([m.message, m.agent, m.timestamp])
  ).sort(byTime);

  const claims: Record<string, ClaimEntry> = {};
  for (const area of new Set([...Object.keys(a.claims), ...Object.keys(b.claims)])) {
    const x = a.claims[area];
    const y = b.claims[area];
    if (!x) {
      claims[area] = clone(y);
      continue;
    }
    if (!y) {
      claims[area] = clone(x);
      continue;
    }
    claims[area] = clone(laterWins(x, timeMs(x.expires), y, timeMs(y.expires))[0]);
  }

  const ca = timeMs(a.created);
  const cb = timeMs(b.created);
  const created = ca > 0 && cb > 0 ? (ca <= cb ? a.created : b.created)
    : ca > 0 ? a.created
    : cb > 0 ? b.created
    : new Date().toISOString();

  return {
    version: SCHEMA_VERSION,
    created,
    contexts,
    sessions: [...sessionsById.values()],
    failures,
    claims,
    broadcasts,
    patterns: {
      works: [...new Set([...a.patterns.works, ...b.patterns.works])],
      fails: [...new Set([...a.patterns.fails, ...b.patterns.fails])],
    },
  };
}

/**
 * Shared JSON store with a cross-process lock.
 *
 * Every mutation runs under `${file}.lock` (O_EXCL create), so concurrent
 * agents in different processes never overwrite each other's writes.
 * Writes go to a temp file and are renamed into place, so readers never see
 * a partial file. A corrupt store is copied aside (never silently discarded).
 */
export class ContextStore {
  private readonly lockFile: string;
  private static readonly STALE_LOCK_MS = 10_000;

  constructor(private readonly cfg: Config) {
    this.lockFile = `${cfg.file}.lock`;
  }

  get file(): string {
    return this.cfg.file;
  }

  /** Runs `fn` against a consistent snapshot. Does not write. */
  read<T>(fn: (d: ContextData) => T): T {
    return this.transact(fn, false);
  }

  /** Runs `fn` under the lock and persists the result. */
  write<T>(fn: (d: ContextData) => T): T {
    return this.transact(fn, true);
  }

  /**
   * Merges remotely-synced data into the store under the cross-process lock. Union by
   * id/key: remote entries are added, conflicts resolve deterministically, local entries
   * are never deleted. Returns true when the store changed. Throws StoreError when the
   * remote data is unreadable or from a newer schema, leaving the store untouched.
   */
  mergeRemote(remote: unknown): boolean {
    let changed = false;
    this.write(d => {
      const merged = mergeData(d, remote);
      if (fingerprint(d) !== fingerprint(merged)) {
        for (const k of Object.keys(d)) delete (d as unknown as Record<string, unknown>)[k];
        Object.assign(d, merged);
        changed = true;
      }
    });
    return changed;
  }

  /** Byte size of the store file, or 0 if it does not exist yet. */
  sizeBytes(): number {
    try {
      return fs.statSync(this.cfg.file).size;
    } catch {
      return 0;
    }
  }

  private transact<T>(fn: (d: ContextData) => T, persist: boolean): T {
    // Identifies this acquisition so a lock stolen by another process is never released (or
    // written over) by us, even if we were paused longer than the stale-lock threshold.
    const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    this.acquire(token);
    try {
      const data = this.load();
      const result = fn(data);
      if (persist) {
        // A stale-lock break by another process means we no longer own the critical section;
        // refusing to write is safer than clobbering a concurrent writer's update.
        this.assertOwner(token);
        this.save(data);
      }
      return result;
    } finally {
      this.release(token);
    }
  }

  /** True when the lock file on disk is still ours. */
  private owns(token: string): boolean {
    try {
      return fs.readFileSync(this.lockFile, "utf-8").trim() === token;
    } catch {
      return false;
    }
  }

  private assertOwner(token: string): void {
    if (!this.owns(token)) {
      throw new StoreError(
        `lost the store lock ${this.lockFile} before writing (another process took over); retry the operation`
      );
    }
  }

  private load(): ContextData {
    if (!fs.existsSync(this.cfg.file)) return emptyData();
    const raw = fs.readFileSync(this.cfg.file, "utf-8");
    try {
      return normalize(JSON.parse(raw));
    } catch (e) {
      if (e instanceof StoreError) throw e;
      const backup = `${this.cfg.file}.corrupt-${Date.now()}`;
      fs.copyFileSync(this.cfg.file, backup);
      log.warn(`store was unreadable (${(e as Error).message}); copied to ${backup} and starting fresh`);
      return emptyData();
    }
  }

  private save(data: ContextData): void {
    fs.mkdirSync(path.dirname(this.cfg.file), { recursive: true });
    const tmp = `${this.cfg.file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmp, this.cfg.file);
    try { schedulePush(this); } catch {}
  }

  private acquire(token: string): void {
    fs.mkdirSync(path.dirname(this.cfg.file), { recursive: true });
    const deadline = Date.now() + this.cfg.lockTimeoutMs;
    for (;;) {
      try {
        const fd = fs.openSync(this.lockFile, "wx", 0o600);
        fs.writeSync(fd, token);
        fs.closeSync(fd);
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      // A lock left behind by a crashed process is removed once it is stale.
      try {
        const age = Date.now() - fs.statSync(this.lockFile).mtimeMs;
        if (age > ContextStore.STALE_LOCK_MS) {
          fs.unlinkSync(this.lockFile);
          continue;
        }
      } catch {
        continue; // lock vanished between checks; retry immediately
      }
      if (Date.now() > deadline) {
        throw new StoreError(`timed out waiting for store lock ${this.lockFile}`);
      }
      sleepSync(5 + Math.floor(Math.random() * 15));
    }
  }

  private release(token: string): void {
    // Only remove the lock if it is still ours: after a stale-lock break it may already
    // belong to another process, and unlinking it would expose their critical section.
    if (!this.owns(token)) return;
    try {
      fs.unlinkSync(this.lockFile);
    } catch {
      // already gone; nothing to do
    }
  }
}

const FAILURE_KEEP = 200;

/**
 * Moves old items out of the live store so it stays small. Completed sessions beyond the newest
 * `keepSessions`, or older than `days`, and failures beyond the newest FAILURE_KEEP are removed from
 * `d` and returned. Nothing is lost: the caller appends them to the archive file. The current session
 * and any session still open are never moved.
 */
export function splitArchive(
  d: ContextData,
  opts: { keepSessions: number; days: number; keepId: string | null; now: number }
): { sessions: SessionEntry[]; failures: FailureEntry[] } {
  const cutoff = opts.now - opts.days * 86_400_000;
  const completed = d.sessions.filter(s => s.status === "completed" && s.id !== opts.keepId);
  const newest = new Set(completed.slice(-opts.keepSessions).map(s => s.id));
  const moveSessions = completed.filter(s => !newest.has(s.id) || Date.parse(s.timestamp) < cutoff);
  const moveIds = new Set(moveSessions.map(s => s.id));
  const sessions = moveSessions;
  d.sessions = d.sessions.filter(s => !moveIds.has(s.id));

  const failures = d.failures.length > FAILURE_KEEP ? d.failures.slice(0, d.failures.length - FAILURE_KEEP) : [];
  d.failures = d.failures.slice(d.failures.length - Math.min(d.failures.length, FAILURE_KEEP));
  return { sessions, failures };
}

/** Appends archived items to the archive file, one JSON object per line. Called under the store lock. */
export function appendArchive(storeFile: string, sessions: SessionEntry[], failures: FailureEntry[]): void {
  if (sessions.length === 0 && failures.length === 0) return;
  const file = `${storeFile}.archive.jsonl`;
  const lines = [
    ...sessions.map(s => JSON.stringify({ kind: "session", archived: new Date().toISOString(), item: s })),
    ...failures.map(f => JSON.stringify({ kind: "failure", archived: new Date().toISOString(), item: f })),
  ];
  fs.appendFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
}
