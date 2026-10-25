#!/usr/bin/env node
"use strict";
/**
 * Connects common-context-mcp to the AI coding tools installed on this machine.
 *
 *  1. Detects which of the supported tools are installed (see scripts/agents.js).
 *  2. Lists them and asks which ones to configure. Nothing is written before a
 *     selection is made.
 *  3. For each selected tool: registers the MCP server in its config and writes
 *     the protocol into its rules / system-prompt file (inside a managed block).
 *  4. For Claude Code, asks separately whether to enable the enforcement hooks.
 *
 * Runs after a global install when a terminal is attached. Without a terminal
 * nothing is written and the command to run is printed. `--yes` configures every
 * detected tool without prompting, for scripted installs.
 */
const readline = require("readline");
const path = require("path");
const os = require("os");
const agents = require("./agents.js");

const log = msg => process.stderr.write(msg + "\n");
const HOME = os.homedir();

function ask(rl, q) {
  return new Promise(resolve => rl.question(q, resolve));
}

/** Parses "1,3", "all", "none" or "" against the detected list. */
function parseSelection(answer, detected) {
  const a = answer.trim().toLowerCase();
  if (a === "" || a === "none") return [];
  if (a === "all") return detected;
  const picked = a
    .split(/[,\s]+/)
    .map(s => parseInt(s, 10) - 1)
    .filter(i => Number.isInteger(i) && i >= 0 && i < detected.length);
  return [...new Set(picked)].map(i => detected[i]);
}

function detectAgents() {
  return agents.AGENTS.filter(a => {
    try {
      return a.detect();
    } catch {
      return false;
    }
  });
}

function printFound(detected) {
  log("  Detected AI tools:");
  detected.forEach((a, i) => log(`    [${i + 1}] ${a.name}  →  ${a.mcp.file}`));
  log("");
}

function printSupported() {
  log("  Supported tools: " + agents.AGENTS.map(a => a.name).join(", ") + ".");
  log("  None of them is installed here. Install one, then run `common-context-mcp-setup`.");
  log("");
}

/** Applies one tool's changes and prints a line per file. Returns counts. */
/** Codex records approval as trusted_hash entries. Their presence means the hooks were reviewed. */
function codexHooksApproved() {
  try {
    return /trusted_hash\s*=/.test(require("fs").readFileSync(path.join(agents.codexHome(), "config.toml"), "utf-8"));
  } catch {
    return false;
  }
}

function configure(selected, enableHooks) {
  const counts = { updated: 0, unchanged: 0, manual: 0, failed: 0 };
  const notes = [];
  log("");
  for (const agent of selected) {
    log(`  ${agent.name}`);
    try {
      for (const r of agents.configureAgent(agent, { enableHooks: enableHooks && Boolean(agent.hooks) })) {
        if (r.status === "manual") {
          counts.manual++;
          log(`    •  ${r.label}: manual step — ${r.path}`);
        } else {
          counts[r.status]++;
          log(`    ${r.status === "updated" ? "✅" : "•"}  ${r.label} (${r.status}) → ${r.path}`);
        }
      }
      if (agent.hooks && !enableHooks) {
        log("    •  enforcement hooks: not enabled (run setup again to enable)");
      }
      if (agent.hooks === "codex" && enableHooks && !codexHooksApproved()) {
        notes.push("Codex: hooks are written but do not run until you approve them. Open Codex, run /hooks, and review the common-context hooks.");
      }
    } catch (e) {
      counts.failed++;
      log(`    ❌ ${e.message}`);
    }
    log("");
  }

  try {
    const status = agents.writeProtocolFile();
    log(`  Protocol text: ${agents.PROTOCOL_FILE} (${status})`);
  } catch (e) {
    counts.failed++;
    log(`  ❌ protocol text: ${e.message}`);
  }

  for (const n of notes) log(`  ⚠  ${n}`);
  log(`  Done: ${counts.updated} updated, ${counts.unchanged} already configured, ${counts.manual} manual, ${counts.failed} failed.`);
  log("  Restart the selected tools to load the server. Backups: <file>.bak-<timestamp>.");
  log("");
  if (counts.failed > 0) process.exitCode = 1;
}

async function run(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    log(`Usage: common-context-mcp-setup [--yes]
  Detects the AI tools installed on this machine (${agents.AGENTS.map(a => a.name).join(", ")}),
  asks which ones to configure, and writes the MCP server and protocol rules for those only.
  --yes   configure every detected tool without prompting (scripted installs)`);
    return;
  }

  // npm sets npm_lifecycle_event=postinstall during installs. A project checkout
  // (local install) must never touch tool configs.
  const fromNpm = process.env.npm_lifecycle_event === "postinstall";
  if (fromNpm) {
    if (process.env.npm_config_global !== "true") {
      log("[common-context] Local install: tool setup skipped. Run `common-context-mcp-setup` to configure tools.");
      return;
    }
    if (process.env.CONTEXT_MCP_NO_SETUP) {
      log("[common-context] CONTEXT_MCP_NO_SETUP is set: tool setup skipped. Run `common-context-mcp-setup` later.");
      return;
    }
  }

  const yes = argv.includes("--yes");
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !yes;

  log("");
  log("common-context-mcp — tool setup");
  log(`  Shared store: ${process.env.CONTEXT_MCP_FILE || path.join(HOME, ".shared-context.json")} (created on first use)`);
  log("");

  const detected = detectAgents();
  if (detected.length === 0) {
    printSupported();
    return;
  }
  printFound(detected);

  if (!interactive && !yes) {
    log("  Not running in a terminal, so nothing was configured.");
    log("  Run `common-context-mcp-setup` in a terminal to choose tools.");
    log("");
    return;
  }

  if (yes) {
    return configure(detected, !process.env.CONTEXT_MCP_NO_HOOKS);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await ask(rl, "  Configure which tools? Numbers (e.g. 1,3), 'all', or Enter for none: ");
  const selected = parseSelection(answer, detected);
  let enableHooks = false;
  if (selected.some(a => a.hooks)) {
    const h = await ask(rl, `  Enable enforcement hooks for ${selected.filter(a => a.hooks).map(a => a.name).join(" and ")} (block work until the protocol is followed)? [Y/n]: `);
    enableHooks = h.trim() === "" || /^y(es)?$/i.test(h.trim());
  }
  rl.close();

  if (selected.length === 0) {
    log("  Nothing selected. No changes made.");
    log("");
    return;
  }
  return configure(selected, enableHooks);
}

module.exports = { parseSelection, withServer: agents.withJsonServer, withClaudeHooks: agents.withClaudeHooks, COMMAND: agents.COMMAND, SERVER_KEY: agents.SERVER_KEY };

if (require.main === module) {
  run(process.argv.slice(2)).catch(err => {
    log(`[common-context] setup error: ${err.message}`);
    // Never fail an npm install because a tool config could not be edited.
    process.exitCode = process.env.npm_lifecycle_event === "postinstall" ? 0 : 1;
  });
}
