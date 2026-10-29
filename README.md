# common-context-mcp

<div align="center">

# 🧠 common-context-mcp

**Shared, append-only context store for AI agents — over the Model Context Protocol (MCP).**

Agents checkpoint their work, record failures, claim files, hand off tasks, and recover after crashes — so the next agent starts exactly where the last one stopped.

**common context MCP** (also published as [`common-context-mcp`](https://www.npmjs.com/package/common-context-mcp)) gives every agent on your machine one shared memory file — one common context that Claude Code, Codex, Cursor, Gemini and OpenCode all read and write.

📦 **npm:** [`npm install -g common-context-mcp`](https://www.npmjs.com/package/common-context-mcp) · 💻 **GitHub:** [Gokulanand-art/common-context-mcp](https://github.com/Gokulanand-art/common-context-mcp)

<br/>

[![npm version](https://img.shields.io/npm/v/common-context-mcp.svg?color=blue&label=version)](https://www.npmjs.com/package/common-context-mcp)
[![npm downloads](https://img.shields.io/npm/dm/common-context-mcp.svg?color=green)](https://www.npmjs.com/package/common-context-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js ≥ 18](https://img.shields.io/badge/node-%3E%3D18-blue.svg)](https://nodejs.org/)
[![CI](https://img.shields.io/github/actions/workflow/status/Gokulanand-art/common-context-mcp/ci.yml?branch=main&label=CI)](https://github.com/Gokulanand-art/common-context-mcp/actions/workflows/ci.yml)
[![Glama MCP](https://img.shields.io/badge/MCP-Glama-purple?logo=glama)](https://glama.ai/mcp/servers/Gokulanand-art/common-context-mcp)

<br/>

**Built by [Gokulanand](https://github.com/Gokulanand-art) · Agent Orchestration · Knowledge & Memory · Developer Tools**

</div>

---

## 🎬 See it in action

> Add your own demo GIF below — record a terminal session with `asciinema` or `ttygif`, save it as `docs/demo.gif`, and uncomment the line:

<!-- ![common-context-mcp in action](./docs/demo.gif) -->

---

## 🚀 Quick start

### 1. Install

```bash
npm install -g common-context-mcp
common-context-mcp-setup
```

The setup step detects your AI tools (Claude Code, Codex, Cursor, Gemini, OpenCode) and wires up the MCP server + protocol block for each one you pick.

### 2. Use it in any project

```bash
# Start a session — loads what the team already knows
common-context-mcp load_context

# Save a checkpoint after meaningful work
common-context-mcp save_context \
  --key "progress" \
  --value "Implemented the login handler"

# Record a failure so nobody repeats it
common-context-mcp save_failure \
  --approach "tried X" \
  --why_failed "X timed out under load"

# Close the session with a summary before your final answer
common-context-mcp save_summary \
  --title "Login handler" \
  --accomplished "Handler implemented and tested"
```

---

## ⚡ The protocol (mandatory, every message)

The server sends these instructions to every connected agent. Follow them in order:

| # | Step | Tool | Why |
|:---:|---|---|---|
| 1 | **Load first** | `load_context` | Before any other tool or reply — starts your session |
| 2 | **Checkpoint** | `save_context` | After every meaningful step — this is your save point |
| 3 | **Record failures** | `save_failure` → `search_context` | Immediately on error, then search before any alternative |
| 4 | **Claim files** | `claim_area` → `release_area` | Before/after editing a shared file — avoids collisions |
| 5 | **Summarize** | `save_summary` | Before your final answer — marks the session complete |

---

## 🛠️ Tools reference

| Tool | Purpose | Read-only |
|:---|:---|:---:|
| `load_context` | Start a session; load shared state, recent sessions, failures, interrupted work | |
| `save_context` | Save a fact/decision/config under a key; overwrites keep history | |
| `save_summary` | Close session with accomplished, learned, decisions, next steps | |
| `save_failure` | Record a failed approach and why, so future agents see it | |
| `record_success` | Record an approach that worked, so it's preferred next time | |
| `search_context` | Case-insensitive search across contexts, sessions, failures, broadcasts | ✓ |
| `claim_area` | Claim a file/area so others avoid it (auto-expires) | |
| `release_area` | Release a claimed area | |
| `list_claims` | List all currently active (unexpired) area claims | ✓ |
| `broadcast` | Send a decision or message to all agents | |
| `handoff` | Transfer work to another agent with full context | |
| `get_patterns` | Learned patterns: what works and what fails, with counts | ✓ |
| `get_audit_trail` | Recent sessions, failures, claims — most recent first | ✓ |
| `resume_session` | Take over an interrupted session (refuses completed/live ones) | |
| `session_status` | Store health: size, counts, interrupted sessions, estimated tokens | ✓ |

> Every tool except `load_context` and `search_context` requires `load_context` to have run first in that session.

---

## 🤖 Supported agents

| Agent | Config written to | Protocol block | Enforcement |
|:---|:---|:---|:---|
| Claude Code | `~/.claude.json` | `~/.claude/CLAUDE.md` | `~/.claude/settings.json` hooks |
| Codex CLI | `$CODEX_HOME/config.toml` | `AGENTS.override.md` / `AGENTS.md` | `[[hooks]]` in config.toml |
| Cursor | `~/.cursor/mcp.json` | Manual paste from setup | `~/.cursor/hooks.json` |
| Gemini CLI | `~/.gemini/settings.json` | `~/.gemini/GEMINI.md` | `hooks` in settings.json |
| OpenCode | `~/.config/opencode/opencode.json` | `~/.config/opencode/AGENTS.md` | Plugin at `~/.config/opencode/plugins/common-context/index.js` |

Text outside the managed block is never touched; reruns replace only that block.

---

## ⚙️ Configuration

| Variable | Default | Meaning |
|:---|:---|:---|
| `CONTEXT_MCP_PROJECT_DIR` | working directory | Project folder; its store is `common-context.json` inside |
| `CONTEXT_MCP_FILE` | `<project>/common-context.json` | Store file, overriding the project folder |
| `CONTEXT_MCP_AGENT_ID` | random per process | Stable agent identity (e.g. `claude-code-laptop`) |
| `CONTEXT_MCP_STALE_MINUTES` | `15` | Idle time before a session is marked dead |
| `CONTEXT_MCP_CLAIM_MINUTES` | `30` | Claim lifetime without renewal |
| `CONTEXT_MCP_MAX_OUTPUT_CHARS` | `40000` | Cap on any single tool response |
| `CONTEXT_MCP_LOAD_BUDGET_CHARS` | `6000` | Max chars the brief `load_context` view may produce |
| `CONTEXT_MCP_ARCHIVE_SESSIONS` | `100` | Completed sessions kept; older ones move to archive |
| `CONTEXT_MCP_ARCHIVE_DAYS` | `30` | Completed sessions older than this move to archive |
| `CONTEXT_MCP_LOG_LEVEL` | `warn` | `error`, `warn`, `info`, or `debug` |
| `CONTEXT_MCP_LOG` | `text` | `text` or `json` log lines on stderr |
| `CONTEXT_MCP_NO_SETUP` | unset | Skip setup prompt after global install |
| `CONTEXT_MCP_NO_HOOKS` | unset | Skip Claude Code enforcement hooks in `--yes` mode |
| `CONTEXT_MCP_ENFORCE` | unset | Set to `0` to turn off Claude Code enforcement at runtime |

---

## 🔄 Multi-agent behaviour

* **Heartbeats.** Each write refreshes its session's heartbeat. When an agent calls `load_context`, any session whose heartbeat is older than `CONTEXT_MCP_STALE_MINUTES` is marked `interrupted`. Sessions still heartbeating are listed as active elsewhere.
* **Claims.** A claim blocks other agents until it expires or is released. Expired claims are removed on the next `load_context`.
* **Resuming.** `resume_session` refuses completed sessions and sessions another live agent is heartbeating — two agents can't drive the same session.

If a task involves long silent stretches, call `save_context` or `session_status` periodically, or raise `CONTEXT_MCP_STALE_MINUTES`.

---

## 💾 Storage & safety

* **File.** One JSON file (`common-context.json` per project folder). Writes go to a temp file and are renamed into place — a crash never leaves a half-written store.
* **Locking.** Mutations run under `<store>.lock` (exclusive create). A lock older than 10 seconds is treated as crash-left-behind and removed.
* **Corruption.** An unreadable store is copied to `<store>.corrupt-<timestamp>` before a fresh store starts. Nothing is silently discarded.
* **Schema.** Schema v2 is current. Older v1 stores upgrade on first write. A newer schema is refused rather than overwritten.
* **Permissions.** File created with mode `0600`.
* **Growth.** Nothing is deleted. `load_context` shows recent items; older ones are reachable via `search_context` and `get_audit_trail`. `session_status` warns when the store is large.
* **Secrets.** The store is plain text — do not save credentials or tokens with `save_context`.

---

## 🩺 Health check

```bash
common-context-mcp doctor
```

Checks Node version, binary on PATH, store writability, read/lock capability, interrupted sessions, and agent registration. Exits non-zero if anything's broken.

```bash
common-context-mcp doctor --tokens
```

Shows estimated token cost of each part agents see every session.

---

## 🛠️ Development

```bash
npm install          # install dependencies
npm run build        # compile src/ to dist/
npm run typecheck    # TypeScript strict check
npm test             # build, then run the test suite
```

CI runs on Node 18, 20, 22 (ubuntu + macOS). The suite covers cross-process locking with real concurrent processes, corruption and schema handling, the full MCP tool surface over stdio, and the installer against a temporary `HOME`.

---

## 🤝 Contributing

Contributions are welcome!

1. Fork the repo and create a feature branch from `main`
2. Add or update tests for any behavior change
3. Run `npm test` and `npm run typecheck`
4. Open a pull request describing what changed and why

See [CHANGELOG.md](CHANGELOG.md) for release history and [LICENSE](LICENSE) for the MIT license.

---

## 🔗 Related

| Resource | Link |
|:---|:---|
| common-context-mcp on Glama | https://glama.ai/mcp/servers/Gokulanand-art/common-context-mcp |
| common-context-mcp on npm | https://www.npmjs.com/package/common-context-mcp |
| Gokulanand-art on GitHub | https://github.com/Gokulanand-art |

---

> Built and maintained by [Gokulanand](https://github.com/Gokulanand-art).  
> If this helps your agents stay in sync, ⭐ star the repo — it helps others discover it.

---

## License

[MIT](LICENSE)
