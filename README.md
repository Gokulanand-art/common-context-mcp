# common-context-mcp

Shared context MCP for AI agents. Append-only, zero config, auto-detect.

## Install

```bash
npm install -g common-context-mcp
```

That's it. The post-install script automatically configures all detected AI agents (Claude Desktop, Cursor, OpenCode, Windsurf, Cline, Continue). No manual configuration needed.

## How It Works

Every AI agent starts with `load_context()` — gets all prior knowledge. During work, agents save insights and failures. At end, agents save session summaries. The next agent inherits everything.

### 12 Tools

| Tool | When | Purpose |
|------|------|---------|
| `load_context` | Start | Load ALL shared context |
| `save_context` | During work | Save a fact/decision/config |
| `save_summary` | End | Save session summary (mandatory) |
| `save_failure` | On failure | Record what didn't work |
| `search_context` | Anytime | Full-text search |
| `claim_area` | Start work | Prevent conflicts |
| `release_area` | Done work | Release claim |
| `list_claims` | Anytime | See active claims |
| `broadcast` | Anytime | Send decision to all agents |
| `handoff` | Transfer | Transfer work with context |
| `get_patterns` | Before trying | See what works/fails |
| `get_audit_trail` | Review | Full history |

### Storage

Single file: `~/.shared-context.json`
- Append-only (nothing deleted)
- Human-readable JSON
- No database, no cloud, no API keys

### Zero Config

After `npm install -g common-context-mcp`:
1. Binary on PATH
2. All agent configs auto-updated
3. Storage file created
4. Done — every agent auto-connects

### Uninstall

```bash
npm uninstall -g common-context-mcp
```

### Requirements

- Node.js 18+
- No other dependencies

### License

MIT
