# Changelog

## 3.11.0

- **Wrapper-proof saves**: `save_context` now accepts alias arguments (`entry`/`name` for `key`, `content`/`text` for `value`), and `save_summary` derives a title from `accomplished` when `title` is omitted (plus a `summary` alias). Agents behind generic wrappers that hide the tool schemas (e.g. OpenCode's `execute`) no longer fail with `Invalid arguments` for these guesses; genuinely empty calls still fail with a message that spells out the expected shape.
- **Greeting resume**: the protocol (rules files, skill, server instructions, hook text) and the `load_context` output now tell the agent that on a greeting or message with no task, it should briefly summarize what is in progress and what is next, then ask what's on the user's mind. Switching agents mid-repo (Claude limit reached → OpenCode `hi`) now resumes with a briefing instead of a bare greeting.
- Protocol text everywhere now names exact arguments (`save_context` with `key`/`value`, `save_failure` with `approach`/`why_failed`, `claim_area` with `area`, `save_summary` with `title` and the rest) so schema-blind agents stop guessing names from prose. Re-run setup to refresh installed rules files and skills.

## 3.10.0

- **Muse now enforces like Claude**: setup installs lifecycle hooks (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`) into `~/.config/muse/settings.json`, so Muse loads context first, checkpoints work, and summarizes before answering — instead of merely having the tools nearby. Verified against the installed binary: hook payloads match Claude's field for field, `muse exec` runs fire the hooks, and the deny/block shapes match the binary's own validation plus exit code 2. Hook commands use absolute node/script paths because Muse clears the hook environment.
- New `muse` hook source (`--source muse`); hook input also accepts variant payload keys (`tool`/`input`/`params`/`response`/`result`) as a fallback.

## 3.9.1

- Muse setup is now fully automatic: the protocol installs as a global skill (`~/.agents/skills/common-context/SKILL.md`, activation on) instead of a manual paste step. Verified against the installed `muse` binary (`skills validate` + user-scope listing). The skill file is owned: never overwritten when foreign, removed on uninstall only when ours.

## 3.9.0

- `ccm` without configured OAuth now prints Google Cloud setup steps (and the new `ccm --local` escape hatch for setup without login) instead of a bare error. The package supports a bundled OAuth client (`src/default-oauth.ts`) for the maintainer to fill in.
- `login` refuses immediately without an interactive terminal instead of hanging for the browser callback (`CONTEXT_MCP_ALLOW_HEADLESS_LOGIN=1` forces it).
- Fixed agent entries from doc re-verification: Muse needs `transport: "stdio"` (+ `mode: "optional"`, file-level `schema_version: 1`), Zed silently ignores entries without `"source": "custom"`, Windsurf documents `command` plus `args`. Qwen and Kiro verified fine as-is.
- `doctor` now checks that both `ccm` and `common-context-mcp` are on PATH. Redaction also covers Google `ya29.` tokens and `AIza` API keys. Onboarding errors can no longer crash with a stack trace.

## 3.8.0

- New short command **`ccm`**: `ccm doctor`, `ccm login`, `ccm sync`, `ccm --upgrade`, `ccm --help`, and more. Bare `ccm` onboards: it opens the Google login page (required), then back in the terminal sets up every detected AI agent and finishes. The full `common-context-mcp` command keeps working as before (it still starts the MCP server agents run).
- New `ccm --upgrade`: upgrades the global package to the latest release, then re-runs setup so new agent configs are applied. Extra args (e.g. `--yes`) pass through to setup. From a local checkout it only re-runs setup and never touches the package.
- Cleaner login/logout: `logout` now revokes the token with Google (best-effort) before removing the local file, and says which happened. `status` no longer crashes on a token file without an expiry. Malformed token files read as logged-out; login/refresh reject unreadable or token-less Google responses with a plain error instead of saving garbage; denying consent in the browser reports `login denied in the browser`.
- Once logged in, the cloud stores the context: every write uploads in the background (append-only merge as before), `load_context` pulls remote changes in, and `login` stores the current local file at once. Failed uploads stay queued and retry quietly about once a minute. Login remains fully optional — logged out, everything stays local.

## 3.7.0

- Setup now configures five more tools: **Muse** (`~/.config/muse/settings.json`, snake_case `mcp_servers` key), **Qwen Code** (`~/.qwen/settings.json` + `~/.qwen/QWEN.md`), **Zed** (`~/.config/zed/settings.json`, `context_servers` key), **Windsurf** (`~/.codeium/windsurf/mcp_config.json` + global rules), and **Kiro** (`~/.kiro/settings/mcp.json` + `~/.kiro/steering/common-context.md`). Locations were checked against each tool's docs.
- Muse and Zed document no global rules file, so they get a manual paste step (like Cursor) instead of a guessed path.
- Roo Code was deliberately left out: it is discontinued (migrating to Kilo Code, which is already supported).

## 3.6.4

- Fix a release-blocking test: the doctor sync test asserted exit 0, which fails where the binary is not on PATH (CI runners). Test-only change since 3.6.3.

## 3.6.3

- **Hardening pass from production validation.** No new tools; many small fixes.
- Fixed: `__proto__`/`constructor` keys crashed tools and could wedge sync. They are rejected at write time and stripped on load/merge.
- Fixed: every Drive/OAuth request now carries a 20s timeout, so a stalled network degrades to local-first instead of hanging tools.
- Fixed: `login` crashed on machines without a browser opener (headless Linux, Windows); it now falls back to printing the URL.
- Sync: token refresh is serialized across processes; 401/403 responses refresh-and-retry once; same-named duplicate remotes resolve newest-first; custom-named store files get their own remote (default names unchanged); failed pushes retry about once a minute in the server; `sync_status` lists sibling remotes and flags the legacy 3.4/3.5 file.
- Archive: `search_context` and `get_audit_trail` now include archived items (as documented); archived items no longer resurrect through sync; archive appends dedupe; broadcasts archive past 200; context history capped at 50.
- Setup: new `common-context-mcp-setup --uninstall` removes the server, rules and hooks per tool; installer backups capped at ten per file.
- `doctor` reports sync state (advisory, never fails); OAuth login uses a `state` check; redaction covers private keys and fine-grained tokens; roots backoff for stalled clients; week-old hook state, stale tmp files and old backups are swept.
- CI now tests Node 24.

## 3.6.2

- Fix the 3.6.1 release: drop `registry-url` from the release workflow. It made setup-node export a GitHub token as `NODE_AUTH_TOKEN`, which blocked npm's OIDC exchange (any token env wins over OIDC). No code changes.

## 3.6.1

- Releases now publish through npm OIDC trusted publishing: no `NPM_TOKEN` secret, no rotation. No code changes since 3.6.0.

## 3.6.0

- **Drive sync is now merge-based, per project.** Each project syncs to its own remote file (`common-context--<project>.json`) instead of all projects sharing one file that overwrote each other. The identity is `CONTEXT_MCP_SYNC_ID` when set, else the git origin URL (stable across machines), else a hash of the folder.
- Sync merges instead of replacing: contexts resolve per key by latest `updated` (loser kept in history), sessions union by id (completed stays completed; id collisions keep both), failures/broadcasts/patterns union. A push merges a changed remote before uploading, so concurrent machines converge instead of losing entries.
- Sync state moved to a `<store>.sync.json` sidecar (last remote version, last push hash): no-change pulls and pushes are skipped, and staleness no longer depends on comparing clocks across machines.
- Removed the 3.4.0 global-store switch: per-project stores sync correctly now, so login no longer relocates the store. Local files stay untouched; each project's next push creates its new remote file (the old shared `common-context.json` remote is left orphaned on Drive).
- `common-context-mcp sync` now pulls then pushes, as documented. `--help` lists the `login`/`logout`/`sync`/`status` subcommands. `sync_status` also shows the project's remote file and last pull/push times.
- Sync tests run against an in-memory Drive stub with an isolated HOME; they no longer touch the real `~/.config`.

## 3.5.0

- Setup now also configures **Hermes Agent** (Nous Research): the server goes in a managed block under `mcp_servers:` in `$HERMES_HOME/config.yaml` (default `~/.hermes`), and the protocol goes first in `$HERMES_HOME/SOUL.md`. The output was checked to load as YAML, and the protocol text passes Hermes's own prompt-injection scan for context files.
- The Goose and Hermes YAML edits share one writer; both refuse an inline map and a same-named server they did not write.

## 3.4.0

- **Google Drive sync.** New `common-context-mcp login` (Google OAuth2, loopback browser flow) grants read+write to the app's hidden Drive folder (`drive.appdata` scope, counts toward the user's 15 GB). The context JSON is stored there, so the same context is available on any machine after login.
- Local file stays primary (works offline); `load_context` pulls from Drive when the remote is newer, writes push back (debounced). Conflict strategy: last write wins by `modifiedTime`.
- When logged in with no explicit `CONTEXT_MCP_FILE`/`CONTEXT_MCP_PROJECT_DIR`, the store defaults to `~/.config/common-context-mcp/common-context.json` (global, synced). Explicit env vars keep per-project mode.
- New CLI subcommands: `login`, `logout`, `sync`, `status`. New MCP tools: `sync_status`, `sync_now`.
- New OAuth env vars: `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (also `AURA_*`), read from env or `~/.aura/google-oauth.env` / `~/.config/common-context-mcp/oauth.env`.


## 3.3.1

- Version bump only. No code changes since 3.3.0.

## 3.3.0

- Setup now also configures **Kilo Code**, **Cline**, **Goose** and **Freebuff**: the MCP server and the protocol block, with a backup of every file it changes. Goose's `config.yaml` is edited as text inside a managed block, so the rest of the file is untouched. Kilo gets the protocol file added to its `instructions` list.
- **Aider** is listed but never written: it has no MCP client, so it could not call the tools. Setup says so.
- These four have no enforcement hooks, so the protocol is advice for them, not a gate.

## 3.2.0

- `search_context` now works before `load_context`, as the protocol, README and enforcement hooks already stated — it is the documented exception to the load-first gate. Writes stay gated.
- After `save_summary`, the next `load_context` starts a new session instead of silently reusing the completed one, so checkpoints land on a session that is still open.
- Store lock hardening: the lock file carries an ownership token. Releasing only removes a lock still owned by this process, and a write is refused if another process broke our stale lock and took over mid-operation — previously a paused writer could unlock someone else's critical section.
- package.json gains `repository`, `homepage` and `bugs` fields, so the npm page cross-links the GitHub repo, plus a `common context mcp` keyword.

## 3.1.1

- Fix: a tool call refused by the enforcement gate is no longer recorded as a new failure. Before this, each refusal replaced the pending error with the refusal text, so agents (seen in OpenCode) saw every tool "fail" with a confusing, changing message.
- `load_context` now clears a pending error, as `search_context` and `save_failure` already did.

## 3.1.0

- **Smaller context for agents.** `load_context` returns a brief view by default, held to `CONTEXT_MCP_LOAD_BUDGET_CHARS` (6000 characters, about 1,500 tokens). It keeps the newest items of each kind and drops the least important sections first, with a note on what was left out. `detail: "full"` returns everything.
- On a large store (300 sessions, 200 failures, 150 context entries), the brief view is about 1,200 tokens. The full view is about 12,000 tokens on the author's real store.
- `search_context` returns up to 8 short excerpts (`limit` raises that to 25) instead of full records.
- The protocol text is shorter. Agents get the full hook protocol once per session and a one-line reminder after that. The strict rules are unchanged.
- Tool descriptions no longer repeat the load requirement. The server instructions are shorter.
- Write-time caps: text in `save_context` and `save_summary` is clipped to 4000 and 1500/800/300 characters. The hook's auto-summary keeps 600 characters.
- Store archiving: old completed sessions (beyond the newest 100, or older than 30 days) and failures beyond the newest 200 move to `<store>.archive.jsonl`. Nothing is deleted. The current session is never moved.
- Credentials are redacted in `save_context`, `save_summary` and `save_failure`, not only in hook records.
- Diagnostics go through a leveled logger: `CONTEXT_MCP_LOG_LEVEL` (error, warn, info, debug) and `CONTEXT_MCP_LOG` (text or json).
- `common-context-mcp doctor --tokens` reports the estimated tokens each part costs.
- A release workflow publishes tagged versions with npm provenance. It needs an `NPM_TOKEN` secret.
- The rules block in agent files is shorter; running `common-context-mcp-setup` rewrites it in place.

## 3.0.2

- The install instructions show the setup step right after `npm install -g common-context-mcp`: run `common-context-mcp-setup`.
- The message printed when setup can't run in a terminal names that next step.

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
