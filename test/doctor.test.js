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
