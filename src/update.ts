import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { VERSION } from "./server.js";
import { runSetupScript } from "./onboard.js";

const PACKAGE = "common-context-mcp";
// npm is a .cmd file on Windows, which needs a shell to run.
const SHELL = process.platform === "win32";

/**
 * Compares dotted numeric versions. Negative when a < b, 0 when equal,
 * positive when a > b. Missing parts count as zero ("3.7" equals "3.7.0").
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] => {
    const parts = v.trim().split(".");
    if (parts.some(p => !/^\d+$/.test(p))) {
      throw new Error(`cannot compare versions ${JSON.stringify(a)} and ${JSON.stringify(b)}`);
    }
    return parts.map(Number);
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function npmViewLatest(): string {
  const r = spawnSync("npm", ["view", `${PACKAGE}@latest`, "version"], {
    encoding: "utf-8",
    timeout: 30000,
    shell: SHELL,
  });
  const out = (r.stdout ?? "").trim().split("\n")[0] ?? "";
  if (r.error || r.status !== 0 || !out) {
    throw new Error(
      `could not reach the npm registry (${r.error ? r.error.message : (r.stderr ?? "").trim() || "no output"}); check your network and that npm is installed`
    );
  }
  return out;
}

function npmGlobalRoot(): string | null {
  const r = spawnSync("npm", ["root", "-g"], { encoding: "utf-8", timeout: 30000, shell: SHELL });
  if (r.error || r.status !== 0) return null;
  return (r.stdout ?? "").trim() || null;
}

/** True when this copy runs from inside npm's global node_modules. */
function isGlobalInstall(): boolean {
  const root = npmGlobalRoot();
  if (!root) return false;
  const here = path.resolve(__dirname, "..");
  return here === root || here.startsWith(root + path.sep);
}

/**
 * Upgrades the global package to the latest release, then re-runs setup so
 * new agent configs are applied. A local checkout only re-runs setup; the
 * package there is never touched. Returns the process exit code.
 */
export function runUpdate(setupArgs: string[]): number {
  let latest: string;
  try {
    latest = npmViewLatest();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
  let cmp: number;
  try {
    cmp = compareVersions(VERSION, latest);
  } catch {
    console.error(`the registry returned an unreadable version (${JSON.stringify(latest)}); aborting`);
    return 1;
  }
  if (cmp < 0) {
    if (!isGlobalInstall()) {
      process.stdout.write(
        `A newer ${PACKAGE} exists (${latest}), but this is not a global install, so the package is left alone. Running setup only.\n`
      );
    } else {
      process.stdout.write(`Updating ${PACKAGE} ${VERSION} → ${latest}...\n`);
      const r = spawnSync("npm", ["install", "-g", `${PACKAGE}@latest`], {
        stdio: "inherit",
        timeout: 300000,
        shell: SHELL,
      });
      if (r.error || r.status !== 0) {
        console.error(`the upgrade failed${r.error ? `: ${r.error.message}` : ""}; setup was not run`);
        return 1;
      }
    }
  } else {
    process.stdout.write(`${PACKAGE} is already up to date (${VERSION}).\n`);
  }
  return runSetupScript(setupArgs);
}
