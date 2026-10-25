/**
 * Diagnostics go to stderr, never stdout: stdout carries the MCP protocol and hook replies.
 *
 *   CONTEXT_MCP_LOG_LEVEL  error | warn | info | debug (default warn)
 *   CONTEXT_MCP_LOG        text | json (default text)
 */

type Level = "error" | "warn" | "info" | "debug";
const RANK: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };

const level = ((): Level => {
  const v = (process.env.CONTEXT_MCP_LOG_LEVEL ?? "warn").toLowerCase();
  return (v in RANK ? v : "warn") as Level;
})();
const json = (process.env.CONTEXT_MCP_LOG ?? "text").toLowerCase() === "json";

function emit(at: Level, msg: string, fields?: Record<string, unknown>): void {
  if (RANK[at] > RANK[level]) return;
  if (json) {
    process.stderr.write(JSON.stringify({ time: new Date().toISOString(), level: at, msg, ...fields }) + "\n");
  } else {
    process.stderr.write(`[common-context] ${msg}\n`);
  }
}

export const log = {
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
};
