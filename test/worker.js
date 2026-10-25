"use strict";
// Child process: performs N locked increments on a counter stored in the shared file.
const { loadConfig } = require("../dist/config.js");
const { ContextStore } = require("../dist/store.js");

const [file, n] = [process.argv[2], Number(process.argv[3])];
const store = new ContextStore(loadConfig({ CONTEXT_MCP_FILE: file }));
for (let i = 0; i < n; i++) {
  store.write(d => {
    const cur = d.contexts.counter ? Number(d.contexts.counter.value) : 0;
    d.contexts.counter = { value: String(cur + 1), tags: [], agent: `w${process.pid}`, updated: new Date().toISOString(), history: [] };
  });
}
