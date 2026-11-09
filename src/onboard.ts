import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "./config.js";
import { ContextStore } from "./store.js";
import { isLoggedIn, login, syncAfterLogin } from "./google.js";

const SETUP_BIN = "common-context-mcp-setup";
// The setup shim is a .cmd file on Windows, which needs a shell to run.
const SHELL = process.platform === "win32";

/**
 * Runs the agent-setup script, resolving it fresh from PATH so a
 * just-installed copy wins. Falls back to the script beside this install
 * (dev checkouts without the bin on PATH). Returns the exit code.
 */
export function runSetupScript(args: string[]): number {
  const direct = spawnSync(SETUP_BIN, args, { stdio: "inherit", shell: SHELL });
  if (!direct.error) return direct.status ?? 0;
  if ((direct.error as NodeJS.ErrnoException).code !== "ENOENT") {
    console.error(`could not run setup: ${direct.error.message}`);
    return 1;
  }
  const fallback = path.join(__dirname, "..", "scripts", "postinstall.js");
  if (!fs.existsSync(fallback)) {
    console.error(`could not run setup: ${SETUP_BIN} is not on PATH and ${fallback} does not exist`);
    return 1;
  }
  const r = spawnSync(process.execPath, [fallback, ...args], { stdio: "inherit" });
  if (r.error) {
    console.error(`could not run setup: ${r.error.message}`);
    return 1;
  }
  return r.status ?? 0;
}

/**
 * First-run flow for `ccm`: login is required, so the browser opens until
 * the user signs in; then every detected AI agent is set up and the command
 * finishes. Returns the process exit code. `loginFn` exists for tests.
 */
export async function runOnboarding(opts: { loginFn?: () => Promise<void> } = {}): Promise<number> {
  if (!isLoggedIn()) {
    process.stdout.write("Step 1/2: sign in with Google (required for cloud context).\n");
    try {
      await (opts.loginFn ?? login)();
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      return 1;
    }
    const store = new ContextStore(loadConfig());
    const { pull, push } = await syncAfterLogin(store);
    process.stdout.write(
      `cloud: pull ${pull.pulled ? "yes" : "no"} (${pull.reason}), push ${push.pushed ? "yes" : "no"} (${push.reason})\n`
    );
  } else {
    process.stdout.write("Already logged in.\n");
  }
  process.stdout.write("Step 2/2: setting up every detected AI agent.\n");
  return runSetupScript(["--yes"]);
}
