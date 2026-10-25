import * as os from "node:os";
import * as path from "node:path";

export interface Config {
  /** Absolute path of the shared JSON store. */
  file: string;
  /** Identity of this server process. Stable if CONTEXT_MCP_AGENT_ID is set. */
  agentId: string;
  /** A session whose heartbeat is older than this is considered dead. */
  staleMs: number;
  /** How long an area claim lasts without renewal. */
  claimMs: number;
  /** Hard cap on the size of any single tool response. */
  maxOutputChars: number;
  /** How long a write waits for the cross-process lock before failing. */
  lockTimeoutMs: number;
}

function positiveNumber(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    process.stderr.write(`[common-context] Ignoring invalid ${name}="${raw}", using ${fallback}\n`);
    return fallback;
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const file = env.CONTEXT_MCP_FILE?.trim() || path.join(os.homedir(), ".shared-context.json");
  return {
    file: path.resolve(file),
    agentId:
      env.CONTEXT_MCP_AGENT_ID?.trim() ||
      `agent-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
    staleMs: positiveNumber("CONTEXT_MCP_STALE_MINUTES", env.CONTEXT_MCP_STALE_MINUTES, 15) * 60_000,
    claimMs: positiveNumber("CONTEXT_MCP_CLAIM_MINUTES", env.CONTEXT_MCP_CLAIM_MINUTES, 30) * 60_000,
    maxOutputChars: positiveNumber("CONTEXT_MCP_MAX_OUTPUT_CHARS", env.CONTEXT_MCP_MAX_OUTPUT_CHARS, 40_000),
    lockTimeoutMs: 10_000,
  };
}
