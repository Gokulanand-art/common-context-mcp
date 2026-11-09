#!/usr/bin/env node
import { log } from "./log.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, VERSION } from "./server.js";
import { loadConfig } from "./config.js";
import { runDoctor, runTokenReport } from "./doctor.js";
import { runHook } from "./hooks.js";
import { ContextStore } from "./store.js";
import { login, clearTokens, syncStatus, isLoggedIn, flushPendingPush, pullIfNewer, pushNow } from "./google.js";

const HELP = `common-context-mcp ${VERSION}
Shared, append-only context store for AI agents (MCP over stdio).

Usage:
  common-context-mcp            Start the MCP server on stdio (what agents run)
  common-context-mcp --version  Print the version
  common-context-mcp doctor     Check the environment and store health
  common-context-mcp doctor --tokens   Estimated tokens the agents see
  common-context-mcp hook <ev>  Claude Code hook handler (reads event JSON on stdin)
  common-context-mcp login      Sign in with Google for Drive sync (opens the browser)
  common-context-mcp logout     Sign out (removes stored tokens)
  common-context-mcp sync       Pull remote changes, then push (this project's store)
  common-context-mcp status     Show login/token/sync state
  common-context-mcp --help     Print this help
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

const arg = process.argv[2];

if (arg === "login") {
  login().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
  // keep process alive
}
if (arg === "logout") {
  clearTokens();
  process.stdout.write("Logged out. Tokens removed.\n");
  process.exit(0);
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
if (arg === "doctor" && process.argv.includes("--tokens")) {
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
}
if (arg === "--help" || arg === "-h") {
  process.stdout.write(HELP);
  process.exit(0);
}

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

if (arg === "hook" || arg === "login" || arg === "logout" || arg === "sync" || arg === "status") {
  // These subcommands must not start the MCP server.
  if (arg === "hook") runHook(process.argv[3]).then(() => process.exit(0));
} else {
  main().catch(err => {
    log.error(`fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
