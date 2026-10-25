import * as fs from "node:fs";
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

  /** Byte size of the store file, or 0 if it does not exist yet. */
  sizeBytes(): number {
    try {
      return fs.statSync(this.cfg.file).size;
    } catch {
      return 0;
    }
  }

  private transact<T>(fn: (d: ContextData) => T, persist: boolean): T {
    this.acquire();
    try {
      const data = this.load();
      const result = fn(data);
      if (persist) this.save(data);
      return result;
    } finally {
      this.release();
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
      process.stderr.write(
        `[common-context] store was unreadable (${(e as Error).message}); copied to ${backup} and starting fresh\n`
      );
      return emptyData();
    }
  }

  private save(data: ContextData): void {
    fs.mkdirSync(path.dirname(this.cfg.file), { recursive: true });
    const tmp = `${this.cfg.file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmp, this.cfg.file);
  }

  private acquire(): void {
    fs.mkdirSync(path.dirname(this.cfg.file), { recursive: true });
    const deadline = Date.now() + this.cfg.lockTimeoutMs;
    for (;;) {
      try {
        const fd = fs.openSync(this.lockFile, "wx", 0o600);
        fs.writeSync(fd, `${process.pid}\n`);
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

  private release(): void {
    try {
      fs.unlinkSync(this.lockFile);
    } catch {
      // already gone; nothing to do
    }
  }
}
