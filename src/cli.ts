#!/usr/bin/env node
import { log } from "./log.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, VERSION } from "./server.js";
import { loadConfig } from "./config.js";
import { runDoctor, runTokenReport } from "./doctor.js";
import { runHook } from "./hooks.js";
import { ContextStore } from "./store.js";
import { login, logout, syncStatus, isLoggedIn, flushPendingPush, pullIfNewer, pushNow, syncAfterLogin } from "./google.js";
import { runUpdate } from "./update.js";
import { runOnboarding } from "./onboard.js";

const HELP = (prog: string, bareLine: string) => `${prog} ${VERSION}
Shared, append-only context store for AI agents (MCP over stdio).

Usage:
  ${bareLine}
  ${prog} --version  Print the version
  ${prog} --upgrade  Update the package to latest, then re-run setup
  ${prog} doctor     Check the environment and store health
  ${prog} doctor --tokens   Estimated tokens the agents see
  ${prog} hook <ev>  Claude Code hook handler (reads event JSON on stdin)
  ${prog} login      Sign in with Google for Drive sync (opens the browser)
  ${prog} logout     Sign out (revokes and removes stored tokens)
  ${prog} sync       Pull remote changes, then push (this project's store)
  ${prog} status     Show login/token/sync state
  ${prog} --help     Print this help
  common-context-mcp-setup      Register the server with detected AI agents

Environment:
  CONTEXT_MCP_FILE              Store file (default: common-context.json in the project folder)
  CONTEXT_MCP_PROJECT_DIR       Project folder whose common-context.json is used (default: working directory)
  CONTEXT_MCP_AGENT_ID          Stable agent identity (default: random per process)
  CONTEXT_MCP_SYNC_ID           Drive sync identity for this project (default: git origin, else folder hash)
  CONTEXT_MCP_STALE_MINUTES     Session considered dead after this many idle minutes (default 15)
  CONTEXT_MCP_CLAIM_MINUTES     Area claims expire after this many minutes (default 30)
  CONTEXT_MCP_MAX_OUTPUT_CHARS  Cap on any single tool response (default 40000)
`;

async function main(): Promise<void> {
  const config = loadConfig();
  const server = createServer(config);
  const transport = new StdioServerTransport();

  const shutdown = (signal: string) => {
    log.info(`${signal} received, shutting down`);
    flushPendingPush().finally(() => server.close().finally(() => process.exit(0)));
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", err => {
    log.error(`fatal: ${err.stack ?? err.message}`);
    process.exit(1);
  });

  await server.connect(transport);
  log.info(`${VERSION} running on stdio (store: ${config.file})`);
}

export interface CLIOptions {
  /** Command name shown in help and errors. */
  prog: string;
  /** What bare invocation does: start the server, or run first-time onboarding. */
  bare: "server" | "onboard";
  /** What an unknown argument does: start the server (legacy), or print usage. */
  unknown: "server" | "usage";
  argv: string[];
}

/** Shared dispatch for the `ccm` and `common-context-mcp` commands. Never returns. */
export function runCLI({ prog, bare, unknown, argv }: CLIOptions): void {
  const arg = argv[0];
  const help = HELP(prog, bare === "onboard" ? `${prog}             Log in and set up all detected AI agents` : `${prog}            Start the MCP server on stdio (what agents run)`);

  if (arg === "login") {
    login()
      .then(async () => {
        // Login is optional, but once logged in the local copy goes to the cloud at once.
        const store = new ContextStore(loadConfig());
        const { pull, push } = await syncAfterLogin(store);
        process.stdout.write(
          `cloud: pull ${pull.pulled ? "yes" : "no"} (${pull.reason}), push ${push.pushed ? "yes" : "no"} (${push.reason})\n`
        );
        process.exit(0);
      })
      .catch(e => {
        console.error(e.message);
        process.exit(1);
      });
    return; // keep process alive
  }
  if (arg === "logout") {
    logout().then(
      how => {
        process.stdout.write(
          how === "revoked"
            ? "Logged out. Tokens removed and revoked with Google.\n"
            : "Logged out. Tokens removed locally (Google unreachable, token not revoked).\n"
        );
        process.exit(0);
      },
      e => {
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
      }
    );
    return; // keep process alive
  }
  if (arg === "sync") {
    const store = new ContextStore(loadConfig());
    pullIfNewer(store)
      .then(pull =>
        pushNow(store).then(push => {
          process.stdout.write(
            `pull: ${pull.pulled ? "yes" : "no"} (${pull.reason})\npush: ${push.pushed ? "yes" : "no"} (${push.reason})\n`
          );
          process.exit(0);
        })
      )
      .catch(e => {
        console.error(e.message);
        process.exit(1);
      });
    return; // keep process alive
  }
  if (arg === "status") {
    const cfg = loadConfig();
    process.stdout.write(`Logged in: ${isLoggedIn() ? "yes" : "no"}\n${syncStatus(cfg.file)}\n`);
    process.exit(0);
  }
  if (arg === "--version" || arg === "-v") {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }
  if (arg === "--upgrade") {
    process.exit(runUpdate(argv.slice(1)));
  }
  if (arg === "doctor" && argv.includes("--tokens")) {
    process.exit(runTokenReport());
  }
  if (arg === "doctor") {
    runDoctor().then(
      code => process.exit(code),
      e => {
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
      }
    );
    return; // keep process alive
  }
  if (arg === "--help" || arg === "-h") {
    process.stdout.write(help);
    process.exit(0);
  }
  if (arg === "hook") {
    runHook(argv[1]).then(() => process.exit(0));
    return; // keep process alive
  }

  if (arg === undefined) {
    if (bare === "onboard") {
      runOnboarding().then(code => process.exit(code));
      return; // keep process alive
    }
  } else if (unknown === "usage") {
    console.error(`Unknown command: ${arg}\n`);
    process.stdout.write(help);
    process.exit(1);
  }
  main().catch(err => {
    log.error(`fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
