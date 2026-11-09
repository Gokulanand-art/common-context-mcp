#!/usr/bin/env node
import { runCLI } from "./cli.js";

// Full command. Bare invocation starts the MCP server on stdio (what the
// agents run); unknown arguments do the same, as always.
runCLI({ prog: "common-context-mcp", bare: "server", unknown: "server", argv: process.argv.slice(2) });
