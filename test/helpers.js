"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** Fresh temp directory per test; the store file lives inside it. */
function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmcp-"));
  return { dir, file: path.join(dir, "store.json") };
}

module.exports = { tempStore };
