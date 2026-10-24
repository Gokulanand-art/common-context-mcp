#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const os = require("os");

const HOME = os.homedir();
const MCP_ENTRY = {
  command: "common-context-mcp"
};

// Agent config paths
const AGENT_CONFIGS = [
  {
    name: "Claude Desktop",
    path: process.platform === "darwin"
      ? path.join(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json")
      : path.join(HOME, ".config", "claude", "claude_desktop_config.json"),
  },
  {
    name: "Cursor",
    path: path.join(HOME, ".cursor", "mcp.json"),
  },
  {
    name: "OpenCode",
    path: path.join(HOME, ".config", "opencode", "opencode.json"),
  },
  {
    name: "Windsurf",
    path: path.join(HOME, ".codeium", "windsurf", "mcp_config.json"),
  },
  {
    name: "Cline (VS Code)",
    path: path.join(HOME, ".vscode", "mcp.json"),
  },
  {
    name: "Continue",
    path: path.join(HOME, ".continue", "config.json"),
  },
];

function readJson(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch (e) {
    // ignore
  }
  return null;
}

function writeJson(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function addToConfig(config, isMcpServers) {
  if (!config) config = {};
  if (isMcpServers) {
    if (!config.mcpServers) config.mcpServers = {};
    config.mcpServers["common-context"] = MCP_ENTRY;
  } else {
    // Continue format
    if (!config.mcpServers) config.mcpServers = [];
    if (!config.mcpServers.some(s => s.name === "common-context")) {
      config.mcpServers.push({ name: "common-context", ...MCP_ENTRY });
    }
  }
  return config;
}

// Create storage file
const storageFile = path.join(HOME, ".shared-context.json");
if (!fs.existsSync(storageFile)) {
  fs.writeFileSync(storageFile, JSON.stringify({
    version: 1,
    created: new Date().toISOString(),
    contexts: {},
    sessions: [],
    failures: [],
    claims: {},
    broadcasts: [],
    patterns: { works: [], fails: [] }
  }, null, 2), "utf-8");
  console.log("  Created ~/.shared-context.json");
}

// Configure agents
let configured = 0;
for (const agent of AGENT_CONFIGS) {
  const config = readJson(agent.path);
  if (config !== null || fs.existsSync(path.dirname(agent.path))) {
    // Agent directory exists or config exists — configure it
    const isContinue = agent.name === "Continue";
    const isMcpServers = !isContinue;
    const newConfig = addToConfig(config || {}, isMcpServers);
    writeJson(agent.path, newConfig);
    console.log(`  Configured: ${agent.name} (${agent.path})`);
    configured++;
  }
}

console.log(`\ncommon-context-mcp installed successfully!`);
console.log(`Configured ${configured} agent(s).`);
console.log(`Storage: ~/.shared-context.json`);
console.log(`\nRestart your AI agents to activate the shared context MCP.`);
console.log(`No further configuration needed.`);
