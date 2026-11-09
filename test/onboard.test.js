"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Isolate HOME before loading dist modules.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ccmcp-ccmhome-"));
process.env.HOME = HOME;

const { tempStore } = require("./helpers");
const g = require("../dist/google.js");
const { runOnboarding, runSetupScript } = require("../dist/onboard.js");

const ROOT = path.join(__dirname, "..");
const CCM = path.join(ROOT, "dist", "ccm.js");
const FULL = path.join(ROOT, "dist", "index.js");

test("each command names itself in --help", () => {
  const ccm = spawnSync(process.execPath, [CCM, "--help"], { encoding: "utf-8" });
  assert.equal(ccm.status, 0);
  assert.match(ccm.stdout, /ccm +Log in and set up all detected AI agents/);
  assert.match(ccm.stdout, /ccm --upgrade/);
  const full = spawnSync(process.execPath, [FULL, "--help"], { encoding: "utf-8" });
  assert.equal(full.status, 0);
  assert.match(full.stdout, /common-context-mcp +Start the MCP server on stdio/);
});

test("ccm --version prints the version", () => {
  const r = spawnSync(process.execPath, [CCM, "--version"], { encoding: "utf-8" });
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
  assert.equal(r.stdout.trim(), pkg.version);
});

test("ccm rejects unknown commands instead of starting a server", () => {
  const r = spawnSync(process.execPath, [CCM, "--bogus"], { encoding: "utf-8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown command: --bogus/);
});

function recordingSetup(dir) {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const marker = path.join(dir, "setup.marker");
  fs.writeFileSync(path.join(bin, "common-context-mcp-setup"), `#!/bin/sh\necho "ran $@" >> "${marker}"\n`, { mode: 0o755 });
  return marker;
}

test("bare ccm while logged in: skips login, sets up every agent", () => {
  if (process.platform === "win32") return;
  const { dir } = tempStore();
  const tokenDir = path.join(dir, ".config", "common-context-mcp");
  fs.mkdirSync(tokenDir, { recursive: true });
  fs.writeFileSync(path.join(tokenDir, "google-tokens.json"), JSON.stringify({ access_token: "x", expiry_date: Date.now() + 3600_000 }));
  const marker = recordingSetup(dir);
  const env = { ...process.env, HOME: dir, PATH: `${path.join(dir, "bin")}:${process.env.PATH}`, CONTEXT_MCP_NO_HOOKS: "1" };
  const r = spawnSync(process.execPath, [CCM], { env, encoding: "utf-8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Already logged in/);
  assert.equal(fs.readFileSync(marker, "utf-8").trim(), "ran --yes");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("bare ccm while logged out: login is required, setup never runs", () => {
  if (process.platform === "win32") return;
  const { dir } = tempStore();
  const marker = recordingSetup(dir);
  const env = { ...process.env, HOME: dir, PATH: `${path.join(dir, "bin")}:${process.env.PATH}`, CONTEXT_MCP_NO_HOOKS: "1" };
  delete env.GOOGLE_CLIENT_ID;
  delete env.GOOGLE_CLIENT_SECRET;
  const r = spawnSync(process.execPath, [CCM], { env, encoding: "utf-8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Google OAuth not configured/);
  assert.match(r.stderr, /console\.cloud\.google\.com\/apis\/credentials/, "points at client setup steps");
  assert.match(r.stderr, /ccm --local/, "names the local-only escape hatch");
  assert.equal(fs.existsSync(marker), false, "setup never ran without login");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("ccm --local: sets up agents with no login at all", () => {
  if (process.platform === "win32") return;
  const { dir } = tempStore();
  const marker = recordingSetup(dir);
  const env = { ...process.env, HOME: dir, PATH: `${path.join(dir, "bin")}:${process.env.PATH}`, CONTEXT_MCP_NO_HOOKS: "1" };
  delete env.GOOGLE_CLIENT_ID;
  delete env.GOOGLE_CLIENT_SECRET;
  const r = spawnSync(process.execPath, [CCM, "--local"], { env, encoding: "utf-8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /local-only/);
  assert.equal(fs.readFileSync(marker, "utf-8").trim(), "ran --yes");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("ccm login without a terminal fails fast instead of hanging", () => {
  const { dir } = tempStore();
  const env = {
    ...process.env, HOME: dir,
    GOOGLE_CLIENT_ID: "test-id", GOOGLE_CLIENT_SECRET: "test-secret",
  };
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [CCM, "login"], { env, encoding: "utf-8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /interactive terminal/);
  assert.ok(Date.now() - t0 < 30_000, "failed fast, did not wait for a browser");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("headless override skips the terminal check", () => {
  const { dir } = tempStore();
  const env = { ...process.env, HOME: dir, CONTEXT_MCP_ALLOW_HEADLESS_LOGIN: "1" };
  delete env.GOOGLE_CLIENT_ID;
  delete env.GOOGLE_CLIENT_SECRET;
  const r = spawnSync(process.execPath, [CCM, "login"], { env, encoding: "utf-8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Google OAuth not configured/, "reached the creds check past the TTY guard");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an unfilled bundled OAuth client is inert", () => {
  const prevId = process.env.GOOGLE_CLIENT_ID;
  const prevSecret = process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  try {
    assert.equal(g.loadOAuthConfig(), null, "empty placeholder yields no config");
  } finally {
    if (prevId !== undefined) process.env.GOOGLE_CLIENT_ID = prevId;
    if (prevSecret !== undefined) process.env.GOOGLE_CLIENT_SECRET = prevSecret;
  }
});

test("runOnboarding: after login the local copy syncs, then setup runs", async () => {
  if (process.platform === "win32") return;
  const { dir } = tempStore();
  const marker = recordingSetup(dir);
  const prevHome = process.env.HOME;
  const prevPath = process.env.PATH;
  const prevFile = process.env.CONTEXT_MCP_FILE;
  const prevId = process.env.CONTEXT_MCP_SYNC_ID;
  const prevClient = process.env.GOOGLE_CLIENT_ID;
  const prevSecret = process.env.GOOGLE_CLIENT_SECRET;
  const realFetch = global.fetch;
  process.env.HOME = dir;
  process.env.PATH = `${path.join(dir, "bin")}:${prevPath}`;
  process.env.CONTEXT_MCP_FILE = path.join(dir, "store.json");
  process.env.CONTEXT_MCP_SYNC_ID = "onboard-test";
  process.env.GOOGLE_CLIENT_ID = "test-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-secret";
  global.fetch = async () => { throw new Error("offline"); };
  try {
    const code = await runOnboarding({
      loginFn: async () => {
        g.saveTokens({ access_token: "x", refresh_token: "y", expiry_date: Date.now() + 3600_000 });
      },
    });
    assert.equal(code, 0);
    assert.ok(fs.existsSync(path.join(dir, ".config", "common-context-mcp", "google-tokens.json")), "login saved tokens");
    assert.equal(fs.readFileSync(marker, "utf-8").trim(), "ran --yes");
  } finally {
    process.env.HOME = prevHome;
    process.env.PATH = prevPath;
    if (prevFile === undefined) delete process.env.CONTEXT_MCP_FILE;
    else process.env.CONTEXT_MCP_FILE = prevFile;
    if (prevId === undefined) delete process.env.CONTEXT_MCP_SYNC_ID;
    else process.env.CONTEXT_MCP_SYNC_ID = prevId;
    if (prevClient === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = prevClient;
    if (prevSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = prevSecret;
    global.fetch = realFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runSetupScript falls back to the script beside the install", () => {
  if (process.platform === "win32") return;
  const { dir } = tempStore();
  fs.mkdirSync(path.join(dir, ".qwen"), { recursive: true });
  const prevPath = process.env.PATH;
  const prevHome = process.env.HOME;
  process.env.PATH = path.join(dir, "empty-bin");
  fs.mkdirSync(process.env.PATH, { recursive: true });
  process.env.HOME = dir;
  process.env.CONTEXT_MCP_NO_HOOKS = "1";
  try {
    // No setup bin on PATH: the fallback runs the real script from this checkout.
    assert.equal(runSetupScript(["--yes"]), 0);
    const qwen = JSON.parse(fs.readFileSync(path.join(dir, ".qwen", "settings.json"), "utf-8"));
    assert.equal(qwen.mcpServers["common-context"].command, "common-context-mcp");
  } finally {
    process.env.PATH = prevPath;
    process.env.HOME = prevHome;
    delete process.env.CONTEXT_MCP_NO_HOOKS;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
