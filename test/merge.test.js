"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeData, fingerprint, StoreError } = require("../dist/store.js");

const ctx = (value, updated, extra = {}) => ({ value, tags: [], agent: "a", updated, history: [], ...extra });
const sess = (id, extra = {}) => ({
  id, title: "t", status: "active", accomplished: "", learned: "", decisions: "", next_steps: "",
  checkpoint: "", agent: "a", timestamp: "2026-01-01T00:00:00.000Z", heartbeat: "2026-01-01T00:00:00.000Z", ...extra,
});
const fail = (approach, ts) => ({ approach, why_failed: "x", agent: "a", timestamp: ts });
const data = (over = {}) => ({
  version: 2, created: "2026-01-01T00:00:00.000Z", contexts: {}, sessions: [],
  failures: [], claims: {}, broadcasts: [], patterns: { works: [], fails: [] }, ...over,
});

test("disjoint contexts are unioned", () => {
  const m = mergeData(data({ contexts: { a: ctx("1", "2026-01-01T00:00:00.000Z") } }),
    data({ contexts: { b: ctx("2", "2026-01-02T00:00:00.000Z") } }));
  assert.deepEqual(Object.keys(m.contexts).sort(), ["a", "b"]);
});

test("conflicting contexts: later updated wins, loser kept in history, tags unioned", () => {
  const local = data({ contexts: { k: ctx("old", "2026-01-01T00:00:00.000Z", { tags: ["l"], agent: "la" }) } });
  const remote = data({ contexts: { k: ctx("new", "2026-01-02T00:00:00.000Z", { tags: ["r"], agent: "ra" }) } });
  const m = mergeData(local, remote);
  assert.equal(m.contexts.k.value, "new");
  assert.equal(m.contexts.k.agent, "ra");
  assert.deepEqual(m.contexts.k.tags.sort(), ["l", "r"]);
  assert.equal(m.contexts.k.history.length, 1);
  assert.equal(m.contexts.k.history[0].value, "old");
  assert.equal(m.contexts.k.history[0].agent, "la");
  // Direction must not matter: same winner either way (array order may differ, content not).
  const m2 = mergeData(remote, local);
  assert.equal(m2.contexts.k.value, "new");
  assert.equal(m2.contexts.k.history.length, 1);
  assert.equal(m2.contexts.k.history[0].value, "old");
  assert.deepEqual(m2.contexts.k.tags.sort(), ["l", "r"]);
});

test("merging identical stores changes nothing (idempotent, convergent)", () => {
  const a = data({
    contexts: { k: ctx("v", "2026-01-01T00:00:00.000Z", { tags: ["t"] }) },
    sessions: [sess("session-1", { status: "completed" })],
    failures: [fail("f", "2026-01-01T00:00:00.000Z")],
  });
  const m = mergeData(a, JSON.parse(JSON.stringify(a)));
  assert.deepEqual(m, a);
  // Merging a third time (already-merged + remote again) is also a no-op.
  const m2 = mergeData(m, JSON.parse(JSON.stringify(a)));
  assert.deepEqual(m2, a);
});

test("merge inputs are never mutated", () => {
  const a = data({ contexts: { k: ctx("old", "2026-01-01T00:00:00.000Z") } });
  const b = data({ contexts: { k: ctx("new", "2026-01-02T00:00:00.000Z") } });
  const before = JSON.stringify([a, b]);
  mergeData(a, b);
  assert.equal(JSON.stringify([a, b]), before);
});

test("same session on both sides: later heartbeat wins", () => {
  const mk = hb => sess("session-1", { heartbeat: hb, checkpoint: `at ${hb}` });
  const m = mergeData(data({ sessions: [mk("2026-01-01T00:00:00.000Z")] }),
    data({ sessions: [mk("2026-01-02T00:00:00.000Z")] }));
  assert.equal(m.sessions.length, 1);
  assert.equal(m.sessions[0].heartbeat, "2026-01-02T00:00:00.000Z");
});

test("a completed session is never resurrected by a stale open copy", () => {
  const done = sess("session-1", { status: "completed", accomplished: "did it", heartbeat: "2026-01-01T00:00:00.000Z" });
  const stale = sess("session-1", { status: "checkpointed", accomplished: "", heartbeat: "2026-01-03T00:00:00.000Z" });
  for (const m of [mergeData(data({ sessions: [done] }), data({ sessions: [stale] })),
                   mergeData(data({ sessions: [stale] }), data({ sessions: [done] }))]) {
    assert.equal(m.sessions.length, 1);
    assert.equal(m.sessions[0].status, "completed");
    assert.equal(m.sessions[0].accomplished, "did it");
  }
});

test("different sessions sharing an id are both kept, remote one renamed", () => {
  const local = sess("session-1", { agent: "machine-a", timestamp: "2026-01-01T00:00:00.000Z" });
  const remote = sess("session-1", { agent: "machine-b", timestamp: "2026-01-02T00:00:00.000Z" });
  const m = mergeData(data({ sessions: [local] }), data({ sessions: [remote] }));
  assert.equal(m.sessions.length, 2);
  const ids = m.sessions.map(s => s.id).sort();
  assert.deepEqual(ids, ["session-1", "session-2"]);
  assert.deepEqual(m.sessions.map(s => s.agent).sort(), ["machine-a", "machine-b"]);
});

test("failures and broadcasts dedupe exact copies and keep distinct ones, oldest first", () => {
  const shared = fail("boom", "2026-01-02T00:00:00.000Z");
  const m = mergeData(
    data({ failures: [fail("old", "2026-01-01T00:00:00.000Z"), shared], broadcasts: [{ message: "hi", agent: "a", timestamp: "2026-01-01T00:00:00.000Z" }] }),
    data({ failures: [JSON.parse(JSON.stringify(shared)), fail("new", "2026-01-03T00:00:00.000Z")], broadcasts: [{ message: "hi", agent: "a", timestamp: "2026-01-01T00:00:00.000Z" }] })
  );
  assert.deepEqual(m.failures.map(f => f.approach), ["old", "boom", "new"]);
  assert.equal(m.broadcasts.length, 1);
});

test("conflicting claims: later expiry wins", () => {
  const m = mergeData(
    data({ claims: { "a.ts": { agent: "x", since: "2026-01-01T00:00:00.000Z", expires: "2026-01-01T01:00:00.000Z" } } }),
    data({ claims: { "a.ts": { agent: "y", since: "2026-01-01T00:30:00.000Z", expires: "2026-01-01T02:00:00.000Z" } } })
  );
  assert.equal(m.claims["a.ts"].agent, "y");
});

test("patterns are unioned", () => {
  const m = mergeData(
    data({ patterns: { works: ["a"], fails: ["x"] } }),
    data({ patterns: { works: ["a", "b"], fails: [] } })
  );
  assert.deepEqual(m.patterns, { works: ["a", "b"], fails: ["x"] });
});

test("garbage or newer-schema remotes are refused, never merged", () => {
  assert.throws(() => mergeData(data(), "{nope"), StoreError);
  assert.throws(() => mergeData(data(), null), StoreError);
  assert.throws(() => mergeData(data(), { version: 999, contexts: {} }), StoreError);
});

test("reserved keys in either side are dropped, never crash the merge", () => {
  const local = JSON.parse('{"version":2,"created":"t","contexts":{"__proto__":{"value":"x","tags":[],"agent":"a","updated":"t","history":[]}},"sessions":[],"failures":[],"claims":{},"broadcasts":[],"patterns":{"works":[],"fails":[]}}');
  const remote = JSON.parse('{"version":2,"created":"t","contexts":{"constructor":{"value":"y","tags":[],"agent":"b","updated":"t","history":[]}},"sessions":[],"failures":[],"claims":{},"broadcasts":[],"patterns":{"works":[],"fails":[]}}');
  const m = mergeData(local, remote);
  assert.deepEqual(Object.keys(m.contexts), []);
  assert.equal(Object.getPrototypeOf(m.contexts), Object.prototype);
});

test("merged histories are capped", () => {
  const hist = n => Array.from({ length: n }, (_, i) => ({ value: `v${i}`, agent: "a", updated: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z` }));
  const m = mergeData(
    data({ contexts: { k: ctx("a", "2026-01-01T00:00:00.000Z", { history: hist(40) }) } }),
    data({ contexts: { k: ctx("b", "2026-01-02T00:00:00.000Z", { history: hist(40).map(h => ({ ...h, agent: "b" })) }) } })
  );
  assert.ok(m.contexts.k.history.length <= 50, `capped, got ${m.contexts.k.history.length}`);
});

test("a v1 remote upgrades cleanly during merge", () => {
  const v1 = {
    version: 1, created: "2026-01-01T00:00:00.000Z",
    contexts: { k: { value: "v", agent: "a", updated: "2026-01-01T00:00:00.000Z" } },
    sessions: [], failures: [], claims: {}, broadcasts: [], patterns: { works: [], fails: [] },
  };
  const m = mergeData(data(), v1);
  assert.equal(m.contexts.k.value, "v");
  assert.deepEqual(m.contexts.k.tags, []);
  assert.deepEqual(m.contexts.k.history, []);
});
