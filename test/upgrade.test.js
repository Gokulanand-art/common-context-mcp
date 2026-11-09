"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { tempStore } = require("./helpers");

const ROOT = path.join(__dirname, "..");
const CLI = path.join(ROOT, "dist", "index.js");
const update = require("../dist/update.js");

test("compareVersions orders dotted versions and rejects garbage", () => {
  assert.ok(update.compareVersions("3.7.0", "3.8.0") < 0);
  assert.ok(update.compareVersions("3.8.0", "3.7.0") > 0);
  assert.equal(update.compareVersions("3.7.0", "3.7.0"), 0);
  assert.equal(update.compareVersions("3.7", "3.7.0"), 0, "missing parts count as zero");
  assert.ok(update.compareVersions("3.10.0", "3.9.0") > 0, "numeric, not lexicographic");
  assert.throws(() => update.compareVersions("3.7.0", "latest"), /cannot compare/);
});

test("--help lists the update flag", () => {
  const r = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf-8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--upgrade/);
});

/**
 * A fake `npm` on PATH: answers `view` and `root -g` from env vars and logs
 * every call. Lets --upgrade run end to end with no network and no real install.
 */
function fakeBin(dir, { latest, root }) {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(dir, "npm.log");
  fs.writeFileSync(path.join(bin, "npm"),
    `#!/bin/sh\necho "$@" >> "${log}"\n` +
    `if [ "$1" = "view" ]; then echo "${latest}"; fi\n` +
    `if [ "$1" = "root" ]; then echo "${root}"; fi\nexit 0\n`,
    { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "common-context-mcp-setup"),
    `#!/bin/sh\nexec "${process.execPath}" "${path.join(ROOT, "scripts", "postinstall.js")}" "$@"\n`,
    { mode: 0o755 });
  return { bin, log };
}

function updateEnv(dir, bin) {
  return {
    ...process.env, HOME: dir, PATH: `${bin}:${process.env.PATH}`,
    npm_lifecycle_event: "", CONTEXT_MCP_NO_HOOKS: "1",
  };
}

test("--upgrade when current: reports up to date and still runs setup", () => {
  if (process.platform === "win32") return; // the fake bin is a shell script
  const { dir } = tempStore();
  fs.mkdirSync(path.join(dir, ".qwen"), { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
  const { bin, log } = fakeBin(dir, { latest: pkg.version, root: "/nonexistent" });
  const r = spawnSync(process.execPath, [CLI, "--upgrade", "--yes"], { env: updateEnv(dir, bin), encoding: "utf-8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /already up to date/);
  assert.equal(fs.readFileSync(log, "utf-8").includes("install"), false, "no reinstall when current");
  const qwen = JSON.parse(fs.readFileSync(path.join(dir, ".qwen", "settings.json"), "utf-8"));
  assert.equal(qwen.mcpServers["common-context"].command, "common-context-mcp");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("--upgrade when outdated: upgrades globally, then runs setup", () => {
  if (process.platform === "win32") return;
  const { dir } = tempStore();
  fs.mkdirSync(path.join(dir, ".qwen"), { recursive: true });
  // The global root above our dist dir makes this look like a global install.
  const { bin, log } = fakeBin(dir, { latest: "99.0.0", root: ROOT });
  const r = spawnSync(process.execPath, [CLI, "--upgrade", "--yes"], { env: updateEnv(dir, bin), encoding: "utf-8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(log, "utf-8"), /install -g common-context-mcp@latest/);
  const qwen = JSON.parse(fs.readFileSync(path.join(dir, ".qwen", "settings.json"), "utf-8"));
  assert.equal(qwen.mcpServers["common-context"].command, "common-context-mcp");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("--upgrade from a local checkout: skips the upgrade, still runs setup", () => {
  if (process.platform === "win32") return;
  const { dir } = tempStore();
  fs.mkdirSync(path.join(dir, ".qwen"), { recursive: true });
  const { bin, log } = fakeBin(dir, { latest: "99.0.0", root: "/nonexistent" });
  const r = spawnSync(process.execPath, [CLI, "--upgrade", "--yes"], { env: updateEnv(dir, bin), encoding: "utf-8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /not a global install/);
  assert.equal(fs.readFileSync(log, "utf-8").includes("install"), false, "never installs -g from a checkout");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, ".qwen", "settings.json"), "utf-8")).mcpServers["common-context"].command, "common-context-mcp");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("--upgrade with no npm on PATH: fails without touching anything", () => {
  if (process.platform === "win32") return;
  const { dir } = tempStore();
  fs.mkdirSync(path.join(dir, ".qwen"), { recursive: true });
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const r = spawnSync(process.execPath, [CLI, "--upgrade", "--yes"], {
    env: { ...process.env, HOME: dir, PATH: bin, npm_lifecycle_event: "", CONTEXT_MCP_NO_HOOKS: "1" },
    encoding: "utf-8",
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /npm/);
  assert.equal(fs.existsSync(path.join(dir, ".qwen", "settings.json")), false, "setup never ran");
  fs.rmSync(dir, { recursive: true, force: true });
});
