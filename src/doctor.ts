import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { loadConfig } from "./config.js";
import { ContextStore } from "./store.js";
import { VERSION } from "./server.js";

/** `warn` checks are advisory: they never make doctor exit non-zero. */
type Check = { name: string; ok: boolean; warn?: boolean; detail: string };

/** Verifies the environment an agent will run in. Exits non-zero if anything is broken. */
export function runDoctor(): number {
  const config = loadConfig();
  const checks: Check[] = [];

  const major = Number(process.versions.node.split(".")[0]);
  checks.push({ name: "node >= 18", ok: major >= 18, detail: `v${process.versions.node}` });

  const onPath = spawnSync(process.platform === "win32" ? "where" : "which", ["common-context-mcp"], { stdio: "ignore" }).status === 0;
  checks.push({ name: "common-context-mcp on PATH", ok: onPath, detail: onPath ? "yes" : "not found; check your npm global bin directory" });

  const dir = path.dirname(config.file);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.doctor-${process.pid}`);
    fs.writeFileSync(probe, "x");
    fs.unlinkSync(probe);
    checks.push({ name: "store directory writable", ok: true, detail: dir });
  } catch (e) {
    checks.push({ name: "store directory writable", ok: false, detail: `${dir}: ${(e as Error).message}` });
  }

  const store = new ContextStore(config);
  try {
    const counts = store.read(d => ({
      sessions: d.sessions.length,
      contexts: Object.keys(d.contexts).length,
      version: d.version,
    }));
    checks.push({ name: "store readable and lockable", ok: true, detail: `${config.file} (schema v${counts.version}, ${counts.sessions} sessions, ${counts.contexts} contexts)` });
  } catch (e) {
    checks.push({ name: "store readable and lockable", ok: false, detail: (e as Error).message });
  }

  const interrupted = (() => {
    try {
      return store.read(d => d.sessions.filter(s => s.status === "interrupted").length);
    } catch {
      return 0;
    }
  })();
  checks.push({ name: "no interrupted sessions", ok: interrupted === 0, warn: true, detail: interrupted === 0 ? "none" : `${interrupted} need resume_session or review` });

  const registered = ["~/.claude.json", "~/.cursor/mcp.json", "~/.codeium/windsurf/mcp_config.json", "~/.config/opencode/opencode.json"]
    .map(p => p.replace("~", os.homedir()))
    .filter(p => {
      try {
        return fs.readFileSync(p, "utf-8").includes("common-context");
      } catch {
        return false;
      }
    });
  checks.push({ name: "registered with an agent", ok: registered.length > 0, warn: true, detail: registered.length ? registered.join(", ") : "none found; run common-context-mcp-setup" });

  const lines = [`common-context-mcp ${VERSION} doctor`, ""];
  for (const c of checks) {
    const tag = c.ok ? "PASS" : c.warn ? "WARN" : "FAIL";
    lines.push(`${tag}  ${c.name}: ${c.detail}`);
  }
  const failed = checks.filter(c => !c.ok && !c.warn).length;
  const warnings = checks.filter(c => !c.ok && c.warn).length;
  lines.push("", failed === 0 ? `Healthy${warnings ? ` (${warnings} warning(s))` : ""}.` : `${failed} check(s) failed.`);
  process.stdout.write(lines.join("\n") + "\n");
  return failed === 0 ? 0 : 1;
}
