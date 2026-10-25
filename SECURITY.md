# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Report them privately through GitHub's "Report a vulnerability" button on the repository, or contact the maintainer directly. Include the version (`common-context-mcp --version`), steps to reproduce, and the impact you observed.

## What the server does and does not protect

- The store is a plain JSON file, created with mode `0600`. Anyone who can read it can read every saved entry. Do not store credentials, tokens or personal data in it.
- The server has no network listener. It communicates only over stdio with the agent that launched it.
- Setup edits agent configuration files. It backs them up first, preserves their permissions, and skips any file it cannot parse safely.
- Agent identities (`CONTEXT_MCP_AGENT_ID`) are self-declared. Any process that can write the store can act as any agent. Use filesystem permissions, not agent IDs, as the access control.

## Supported versions

Security fixes are released for the latest minor version only.
