"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { tempStore } = require("./helpers");

test("doctor reports the store as healthy on a fresh store", () => {
  const { dir, file } = tempStore();
  const r = spawnSync(process.execPath, [path.join(__dirname, "..", "dist", "index.js"), "doctor"], {
    env: { ...process.env, CONTEXT_MCP_FILE: file },
    encoding: "utf-8",
  });
  assert.match(r.stdout, /PASS  store readable and lockable/);
  assert.match(r.stdout, /PASS  store directory writable/);
  assert.match(r.stdout, /PASS  node >= 18/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("doctor exits 1 when the store cannot be read safely", () => {
  const { dir, file } = tempStore();
  fs.writeFileSync(file, JSON.stringify({ version: 999 }));
  const r = spawnSync(process.execPath, [path.join(__dirname, "..", "dist", "index.js"), "doctor"], {
    env: { ...process.env, CONTEXT_MCP_FILE: file },
    encoding: "utf-8",
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL  store readable and lockable/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("doctor reports which commands are on PATH", () => {
  if (process.platform === "win32") return; // the fake bin relies on which/exec-bit semantics
  const { dir, file } = tempStore();
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const run = p => spawnSync(process.execPath, [path.join(__dirname, "..", "dist", "index.js"), "doctor"], {
    // System dirs stay so the `which` probe itself resolves; npm bins do not.
    env: { ...process.env, CONTEXT_MCP_FILE: file, PATH: `${p}:/usr/bin:/bin` },
    encoding: "utf-8",
  });
  const missing = run(bin);
  assert.match(missing.stdout, /FAIL  command on PATH/);
  assert.match(missing.stdout, /neither ccm nor common-context-mcp found/);
  for (const name of ["ccm", "common-context-mcp"]) {
    fs.writeFileSync(path.join(bin, name), "#!/bin/sh\n", { mode: 0o755 });
  }
  const found = run(bin);
  assert.match(found.stdout, /PASS  command on PATH/);
  assert.match(found.stdout, /ccm, common-context-mcp/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("doctor reports sync state without failing when logged out", () => {
  const { dir, file } = tempStore();
  const home = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "ccmcp-doc-"));
  const r = spawnSync(process.execPath, [path.join(__dirname, "..", "dist", "index.js"), "doctor"], {
    env: { ...process.env, HOME: home, CONTEXT_MCP_FILE: file },
    encoding: "utf-8",
  });
  assert.match(r.stdout, /drive sync/);
  assert.match(r.stdout, /not logged in/);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});
