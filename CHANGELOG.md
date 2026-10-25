# Changelog

## 3.0.1

- The protocol block is the first thing in every agent's rules file, so it is read before the rest of the file. The user's own rules follow it unchanged.
- The protocol applies to every message, including greetings such as "hi". Before this, OpenCode could answer a greeting without calling the MCP.
- `common-context.json` is in `.gitignore`, so each project's store stays out of commits.
- OpenCode checked live: a greeting now calls `load_context` and creates the project's store.

## 3.0.0

- **Breaking:** each project folder has its own store, `common-context.json` in that folder, created on first use. The default is no longer `~/.shared-context.json`. Data already in the old file is not moved; set `CONTEXT_MCP_FILE` to keep using it.
- The store used by a tool call is the one in the project folder. Hooks use the `cwd` that each agent sends with the event. The MCP server asks the client for its workspace roots before each tool call and follows the first `file://` root. Switching folders in an open session starts a new store, and the agent must call `load_context` again. Without client roots, the server uses the folder it started in.
- `CONTEXT_MCP_PROJECT_DIR` sets the project folder explicitly. `CONTEXT_MCP_FILE` still overrides the file.

## 2.9.0

- Strict per-message harness. For every message, the agent must load or search the store first, checkpoint its work with `save_context`, and save the summary last. The stop hook holds the final answer until these are done.
- A summary saved before the checkpoint does not count. Checkpoint first, then `save_summary`.
- The protocol text written to every agent's rules file and the server instructions say the same thing, and apply to every model and agent.

## 2.8.1

- `save_summary` now requires only `title` and `accomplished`. `learned`, `decisions` and `next_steps` are optional. Claude's calls were being rejected whenever it omitted one, so the summary was lost.

## 2.8.0

- OpenCode enforcement works. The plugin uses the current API: `export default { id, setup(ctx) }`, with tool hooks registered through `ctx.tool.hook("execute.before" | "execute.after")`. It lives at `~/.config/opencode/plugins/common-context/index.js`.
- OpenCode calls MCP tools through its `execute` and `search` tools. The gate recognises those calls when they reference common-context. Without this, the MCP could not be loaded in OpenCode and every tool call was blocked.
- Verified live: an unloaded shell call is denied, the MCP can be loaded through OpenCode, and the shell call then runs.
- Not available in OpenCode's API: a per-message reset and a stop-time summary check. Those rules are not enforced there.

## 2.7.2

- Codex hook approvals (`[hooks.state.*]` entries with `trusted_hash`) are kept when the installer rewrites the managed block. Previously a rerun would have removed them, and Codex would ask for approval again.
- The Codex approval note is shown only when the approvals are missing.
- Codex hooks were approved and verified live: UserPromptSubmit, PreToolUse, PostToolUse and Stop all ran.

## 2.7.1

- Fixed: Codex names MCP tools `mcp__common_context__<tool>` (underscore). The gate did not recognise these, so Codex's own MCP calls were blocked. Both spellings are now recognised.
- Codex MCP entry pre-approves only the common-context tools (`default_tools_approval_mode = "approve"`), so non-interactive Codex runs can call the protocol.

## 2.7.0

- Upgraded to zod 4. `npm audit` reports zero vulnerabilities.
- Added a LICENSE file (MIT). The copyright line reads "common-context-mcp contributors"; replace it with the holder's name.
- Claude Code verified live: the Stop hook asked for an MCP lookup, the lookup ran, and the answer came back.
- OpenCode: the plugin does not load in OpenCode 2.1.4. Every plugin shape tried was rejected or hung before loading. OpenCode enforcement is therefore NOT active until the plugin format is confirmed.
- Removed a stale `mcp.servers.common-context` entry that the first installer had written to OpenCode's config.

## 2.6.0

- Enforcement hooks for all five tools: Claude Code, Codex CLI, Cursor, Gemini CLI and OpenCode.
- The hook handlers share one decision model. Each tool's input fields and reply format are handled by an adapter, selected with `--source <tool>`.
- Cursor: `~/.cursor/hooks.json`. Gemini: `hooks` in `~/.gemini/settings.json`. OpenCode: a managed plugin in `~/.config/opencode/plugins/common-context.js`, which is never written over a user's own file.
- MCP tool names are matched under each tool's naming scheme.
- A bug fixed during testing: Cursor's flat hook entries were duplicated on rerun.

## 2.5.0

- Codex CLI fixed: honours `CODEX_HOME`, writes the protocol to `AGENTS.override.md` when it exists (Codex loads that file instead of `AGENTS.md`), and writes enforcement hooks as `[[hooks.<Event>]]` tables in `config.toml`.
- Codex hooks attribute their records to Codex (`CONTEXT_MCP_HOOK_SOURCE=codex`).
- Codex hooks need approval in `/hooks` before they run. Setup tells the user this and does not approve them.
- The managed TOML block also rejects a quoted `[mcp_servers."common-context"]` table written by the user.

## 2.4.0

- Setup covers five tools: Claude Code, Cursor, Codex CLI, Gemini CLI and OpenCode. Each gets its MCP server entry and a managed protocol block in its rules file.
- Cursor's global rules can only be set in its settings, so setup prints a manual step for it.
- Managed blocks are replaced on rerun; text outside them is never touched.
- Codex TOML config is edited with a managed block. A user-defined `[mcp_servers.common-context]` is never overwritten.
- Windsurf, Continue, Claude Desktop, Zed and Aider are no longer configured automatically.

## 2.3.0

- Setup detects installed agents and asks which to configure. Nothing is written to an agent config until a user selects it. Non-interactive runs change nothing.
- Claude Code protocol hooks (`common-context-mcp hook <event>`) enforce the protocol: load before work, a `common-context` call per message, `search_context` before any alternative after an error, `save_summary` before the final answer. Errors are recorded in the store automatically. Visible `systemMessage` lines show each step.
- `ToolSearch` stays reachable so MCP tool schemas can always be loaded.
- Credentials are redacted from recorded failures and summaries.
- `CONTEXT_MCP_ENFORCE=0` disables the hooks; `CONTEXT_MCP_NO_HOOKS=1` skips installing them.

## 2.2.0

Renamed from `agent-nervous-system-mcp` (old bin names remain as aliases).

- Cross-process file lock: concurrent agents no longer lose writes.
- Corrupt stores are copied aside instead of being overwritten.
- Heartbeat-based session liveness: other agents' active sessions are not marked interrupted.
- Claims expire after `CONTEXT_MCP_CLAIM_MINUTES`.
- New tool: `record_success`. `resume_session` refuses completed and live sessions.
- Schema v2 (`heartbeat`, `ended_at`, context `history`); v1 stores upgrade on write; newer schemas are refused.
- Input validation and output caps.
- Setup: merges and backs up configs, keeps file permissions, skips unparseable files, runs automatically only on global installs, detects agents via PATH lookups.
- `common-context-mcp doctor` health check.

## 2.1.0

- Original release as `agent-nervous-system-mcp`.
