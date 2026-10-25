# common-context-mcp

A shared, append-only context store for AI agents, exposed as a [Model Context Protocol](https://modelcontextprotocol.io) server. Agents checkpoint their work, record failures, claim files, hand off tasks, and recover after crashes, so the next agent starts where the last one stopped.

- **Multi-process safe.** Several agents can write at the same time; writes are serialized with a cross-process lock.
- **Crash-tolerant.** Every save is a checkpoint. A session that stops sending heartbeats is detected and can be resumed.
- **Zero infrastructure.** One JSON file, no database, no network service.
- **Auto-configured.** A global install registers the server with detected AI agents, backing up every config it touches.

## Install

```bash
npm install -g common-context-mcp
```

Setup detects which of the supported AI tools are installed, lists them, and asks which ones to configure. Only the tools you select are changed.

| Tool | MCP server written to | Protocol written to |
|------|-----------------------|---------------------|
| Claude Code | `~/.claude.json` | `~/.claude/CLAUDE.md` (managed block), plus enforcement hooks in `~/.claude/settings.json` |
| Cursor | `~/.cursor/mcp.json` | manual: Cursor's global User Rules can only be set in its settings. Setup prints the file to paste from |
| Codex CLI | `$CODEX_HOME/config.toml` (default `~/.codex`) | `$CODEX_HOME/AGENTS.override.md` if it exists, otherwise `$CODEX_HOME/AGENTS.md` (managed block). Enforcement hooks in the same config file |
| Gemini CLI | `~/.gemini/settings.json` | `~/.gemini/GEMINI.md` (managed block) |
| OpenCode | `~/.config/opencode/opencode.json` | `~/.config/opencode/AGENTS.md` (managed block) |

Every file is backed up before it changes, keeps its permissions, and is left alone if it cannot be parsed. The protocol is a managed block: reruns replace only that block, and text outside it is never touched.

```
  Detected AI tools:
    [1] Claude Code  →  ~/.claude.json
    [2] Codex CLI  →  ~/.codex/config.toml
  Configure which tools? Numbers (e.g. 1,3), 'all', or Enter for none:
```

If you select a tool that supports hooks, you are also asked whether to enable enforcement. With enforcement on, the tool cannot skip the protocol:

| Tool | Enforcement mechanism | Reply format |
|------|----------------------|--------------|
| Claude Code | `~/.claude/settings.json` hooks | Claude's hook format |
| Codex CLI | `[[hooks]]` in `config.toml` (approve in `/hooks` before they run) | Claude-compatible |
| Cursor | `~/.cursor/hooks.json` (`beforeSubmitPrompt`, `preToolUse`, `postToolUse`, `stop`) | `permission`, `followup_message` |
| Gemini CLI | `hooks` in `~/.gemini/settings.json` (`BeforeAgent`, `BeforeTool`, `AfterTool`, `AfterAgent`) | `decision`, `reason` |
| OpenCode | `~/.config/opencode/plugins/common-context/index.js` (`ctx.tool.hook`, execute before/after) | `decision`, `reason` |

Enforcement covers: load before work, a common-context call for each message, searching after an error before any alternative, and `save_summary` before the final answer. OpenCode has no end-of-turn hook, so it enforces the tool-level rules only. Cursor's global rules and the OpenCode plugin are not verified against a live session in every case; see the notes below.

Run the wizard again at any time:

```bash
common-context-mcp-setup          # choose tools interactively
common-context-mcp-setup --yes    # configure every detected tool (scripted installs)
```

After a global install in a non-interactive shell (CI, a script), nothing is configured and the command above is printed. Set `CONTEXT_MCP_NO_SETUP=1` to suppress that message.

Requires Node.js 18 or newer.

**Verified against installed binaries:**

- Gemini CLI 0.65.0 ran the hooks in a headless session. The protocol notice showed, and the final answer was blocked as configured.
- Cursor's hook fields (`conversation_id`, `loop_count`, `followup_message`, `permission`) were read from the installed agent bundle. A live session was not run.
- OpenCode 2.1.4: enforcement verified live. Tool calls are gated through the `setup(ctx)` plugin API. OpenCode has no per-message reset or stop-time summary check, so those rules are not enforced there.
- Claude Code: ran live. The Stop hook asked for an MCP lookup and the run completed after the lookup.

**Codex CLI, verified against the installed binary:**

- `CODEX_HOME` is honoured. If it is set, every Codex file is read from there.
- `AGENTS.override.md` replaces `AGENTS.md` when it exists, so the protocol is written to the override file in that case. Writing only to `AGENTS.md` would be silently ignored.
- The enforcement hooks are `[[hooks.<Event>]]` tables in `config.toml`. Codex runs them only after you review them: open Codex, run `/hooks`, and approve the common-context hooks. Setup does not approve them for you.

### Health check

```bash
common-context-mcp doctor
```

Checks the Node version, that the binary is on PATH, that the store directory is writable, that the store can be read and locked, whether any sessions are interrupted, and whether an agent is registered. Exits non-zero if a required check fails.

## The protocol agents follow

The server sends these instructions to every connected agent:

1. `load_context()` first. It starts a session and returns everything the team already knows.
2. `save_context()` after every meaningful step. This is the checkpoint.
3. `save_failure()` immediately when an approach fails, and `record_success()` when one works.
4. `claim_area()` before editing a shared file, `release_area()` when done.
5. `broadcast()` for decisions that affect everyone.
6. `save_summary()` before the final answer.

## Tools

| Tool | Purpose | Read-only |
|------|---------|:---:|
| `load_context` | Start a session. Loads shared state, flags interrupted sessions, lists work in progress by other agents. | |
| `save_context` | Store a fact, decision or config under a key. Overwrites keep prior values in `history`. | |
| `save_summary` | Close the session with what was accomplished, learned, decided, and next steps. | |
| `save_failure` | Record an approach that did not work and why. | |
| `record_success` | Record an approach that worked. | |
| `search_context` | Case-insensitive search across contexts, sessions, failures and broadcasts. | ✓ |
| `claim_area` | Claim a file or area. Claims expire unless renewed. | |
| `release_area` | Release a claim you hold. | |
| `list_claims` | List active claims. | ✓ |
| `broadcast` | Send a message to all agents. | |
| `handoff` | Hand work to a named agent with its context. | |
| `get_patterns` | What works and what fails, with counts. | ✓ |
| `get_audit_trail` | Recent sessions and failures, most recent first. | ✓ |
| `resume_session` | Take over an interrupted session. | |
| `session_status` | Store size, counts, interrupted sessions. | ✓ |

Every tool except `load_context` requires `load_context` to have run first in that server process. Inputs are validated and length-limited.

## Multi-agent behaviour

- **Heartbeats.** Each write refreshes its session's heartbeat. When an agent calls `load_context`, any session whose heartbeat is older than `CONTEXT_MCP_STALE_MINUTES` (default 15) is marked `interrupted`. Sessions still heartbeating are listed as active elsewhere, not interrupted.
- **Claims.** A claim blocks other agents until it expires (`CONTEXT_MCP_CLAIM_MINUTES`, default 30) or is released. Expired claims are removed the next time anyone loads context.
- **Resuming.** `resume_session` refuses completed sessions and sessions another live agent is heartbeating, so two agents cannot drive the same session.

An agent that goes quiet for longer than the stale window looks dead to the others. If a task involves long silent stretches, call `save_context` or `session_status` periodically, or raise `CONTEXT_MCP_STALE_MINUTES`.

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `CONTEXT_MCP_PROJECT_DIR` | working directory | Project folder. Its store is `common-context.json` inside it. |
| `CONTEXT_MCP_FILE` | `<project>/common-context.json` | Store file, overriding the project folder. |
| `CONTEXT_MCP_AGENT_ID` | random per process | Stable identity for this agent (e.g. `claude-code-laptop`). |
| `CONTEXT_MCP_STALE_MINUTES` | `15` | Idle time after which a session is considered dead. |
| `CONTEXT_MCP_CLAIM_MINUTES` | `30` | Claim lifetime without renewal. |
| `CONTEXT_MCP_MAX_OUTPUT_CHARS` | `40000` | Cap on any single tool response. |
| `CONTEXT_MCP_NO_SETUP` | unset | Skip the setup prompt after a global install. |
| `CONTEXT_MCP_NO_HOOKS` | unset | Do not install Claude Code enforcement hooks in `--yes` mode. |
| `CONTEXT_MCP_ENFORCE` | unset | Set to `0` to turn off Claude Code enforcement at runtime. |

Invalid numeric values are reported on stderr and the default is used.

## Storage and safety

- **File.** A single JSON file. Writes go to a temporary file and are renamed into place, so a crash never leaves a half-written store.
- **Locking.** Mutations run under `<store>.lock`, created exclusively. A lock older than 10 seconds is treated as left behind by a crash and removed.
- **Corruption.** An unreadable store is copied to `<store>.corrupt-<timestamp>` before a fresh store is started. Nothing is silently discarded.
- **Schema.** Schema v2 is current. Older v1 stores are upgraded on first write. A store written by a *newer* version is refused rather than overwritten.
- **Permissions.** The file is created with mode `0600`.
- **Growth.** Nothing is deleted, so the store grows over time. `load_context` shows only the most recent items; older ones are reachable through `search_context` and `get_audit_trail`. `session_status` reports the size and warns when it is large.
- **Secrets.** The store is plain text. Do not save credentials or tokens with `save_context`.

## Backup and restore

Copy the store file while no agent is writing, or copy it at any time. To restore, stop the agents and replace the file. Backups made by the setup step are named `<config>.bak-<timestamp>`.

## Troubleshooting

- **"You must call load_context() first"**: the agent skipped step 1 in this server process. Restarting the agent starts a new process.
- **"timed out waiting for store lock"**: another process holds the lock for more than 10 seconds. Check for a stuck agent; a lock older than 10 seconds is removed automatically on the next attempt.
- **Setup says "cannot safely edit"**: the agent's config is not plain JSON (for example it contains comments). Nothing was changed. Add the server by hand: key `common-context`, command `common-context-mcp`.
- **Server does not appear in an agent**: run `common-context-mcp --version` to confirm it is on the PATH, then re-run `common-context-mcp-setup`.

## Development

```bash
npm install
npm run build     # compile src/ to dist/
npm test          # build, then run the test suite (CI runs this on Node 18, 20, 22 for Linux and macOS)
```

The suite covers the store's cross-process locking (with real concurrent processes), corruption and schema handling, the full tool surface over stdio through the MCP client, and the installer (run against a temporary `HOME`).

## License

MIT
