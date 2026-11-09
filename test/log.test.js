"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

test("text logs fold to one line so agents cannot forge log lines", () => {
  delete process.env.CONTEXT_MCP_LOG;
  delete process.env.CONTEXT_MCP_LOG_LEVEL;
  const { log } = require("../dist/log.js");
  const chunks = [];
  const orig = process.stderr.write;
  process.stderr.write = c => (chunks.push(String(c)), true);
  try {
    log.warn("hello\n[common-context] forged line\nbye");
  } finally {
    process.stderr.write = orig;
  }
  assert.equal(chunks.join("").split("\n").filter(Boolean).length, 1);
  assert.match(chunks.join(""), /hello.*forged line.*bye/);
});
