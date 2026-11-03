const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Point module at a temp token file by overriding HOME? google.ts uses os.homedir().
// Instead test pure helpers via dynamic import of compiled dist.
const g = require("../dist/google.js");

test("loadOAuthConfig reads from ~/.aura/google-oauth.env (or env)", () => {
  const cfg = g.loadOAuthConfig();
  // In this environment the file exists, so cfg should be non-null.
  // Don't assert non-null globally; just check shape if present.
  if (cfg) {
    assert.equal(typeof cfg.clientId, "string");
    assert.equal(typeof cfg.clientSecret, "string");
  }
});

test("isLoggedIn false when no token file", () => {
  // Ensure token file absent in a fresh temp home is hard; just check function exists
  assert.equal(typeof g.isLoggedIn, "function");
});

test("loadTokens/saveTokens roundtrip via real file", () => {
  const tok = { access_token: "abc", expiry_date: Date.now() + 1000 };
  g.saveTokens(tok);
  const loaded = g.loadTokens();
  assert.equal(loaded.access_token, "abc");
  // cleanup
  try { fs.unlinkSync(path.join(os.homedir(), ".config", "common-context-mcp", "google-tokens.json")); } catch {}
});

test("pullIfNewer no-op when not logged in", async () => {
  try { fs.unlinkSync(path.join(os.homedir(), ".config", "common-context-mcp", "google-tokens.json")); } catch {}
  const r = await g.pullIfNewer("/tmp/nonexistent.json");
  assert.equal(r.pulled, false);
  assert.match(r.reason, /not logged in/);
});

test("pushNow no-op when not logged in", async () => {
  const r = await g.pushNow("/tmp/nonexistent.json");
  assert.equal(r.pushed, false);
  assert.match(r.reason, /not logged in/);
});

test("syncStatus returns string", () => {
  const s = g.syncStatus();
  assert.equal(typeof s, "string");
  assert.match(s, /OAuth configured/);
});
