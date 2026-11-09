import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "./config.js";
import { ContextStore } from "./store.js";
import { isLoggedIn, loadOAuthConfig, login, syncAfterLogin } from "./google.js";

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

/** Printed when login is impossible: no OAuth client is configured anywhere. */
export const OAUTH_SETUP_GUIDE = `Google OAuth not configured, and login is required.
Create a free OAuth client (one time, about 2 minutes):
  1. Open https://console.cloud.google.com/apis/credentials
  2. Create Credentials → OAuth client ID → Application type: Desktop app
  3. Save the Client ID and Client secret to ~/.config/common-context-mcp/oauth.env:
       GOOGLE_CLIENT_ID=...
       GOOGLE_CLIENT_SECRET=...
  4. Run \`ccm\` again.
To skip login and stay local-only instead: \`ccm --local\`.
`;

/**
 * First-run flow for `ccm`: login is required, so the browser opens until
 * the user signs in; then every detected AI agent is set up and the command
 * finishes. Returns the process exit code. `loginFn` exists for tests, and
 * `skipLogin` implements `--local`.
 */
export async function runOnboarding(opts: { loginFn?: () => Promise<void>; skipLogin?: boolean } = {}): Promise<number> {
  if (opts.skipLogin) {
    process.stdout.write("Skipping login (local-only mode, no cloud sync).\n");
  } else if (!isLoggedIn()) {
    if (!loadOAuthConfig()) {
      console.error(OAUTH_SETUP_GUIDE);
      return 1;
    }
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
