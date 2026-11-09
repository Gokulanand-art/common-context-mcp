"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("package.json, server.json and CHANGELOG agree on the version", () => {
  const root = path.join(__dirname, "..");
  const pkg = require("../package.json");
  const serverJson = require("../server.json");
  assert.equal(serverJson.version, pkg.version, "server.json version");
  assert.equal(serverJson.packages[0].version, pkg.version, "server.json package version");
  const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf-8");
  const escaped = pkg.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(changelog, new RegExp(`^## ${escaped}$`, "m"), "CHANGELOG has a section for this version");
});
