#!/usr/bin/env node
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const zod_1 = require("zod");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
// ─── Storage ───────────────────────────────────────────────
const CONTEXT_FILE = path.join(os.homedir(), ".shared-context.json");
function defaultData() {
    return {
        version: 1,
        created: new Date().toISOString(),
        contexts: {},
        sessions: [],
        failures: [],
        claims: {},
        broadcasts: [],
        patterns: { works: [], fails: [] },
    };
}
function loadData() {
    try {
        if (fs.existsSync(CONTEXT_FILE)) {
            const raw = fs.readFileSync(CONTEXT_FILE, "utf-8");
            return JSON.parse(raw);
        }
    }
    catch (e) {
        console.error("Warning: context file corrupted, starting fresh");
    }
    return defaultData();
}
function saveData(data) {
    const tmp = CONTEXT_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmp, CONTEXT_FILE);
}
// ─── Session State ─────────────────────────────────────────
let sessionLoaded = false;
let sessionCompleted = false;
let agentId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
function requireLoaded() {
    if (!sessionLoaded) {
        return "ERROR: You must call load_context() first before using any other tool. This is MANDATORY.";
    }
    return null;
}
function now() {
    return new Date().toISOString();
}
// ─── MCP Server ────────────────────────────────────────────
const server = new mcp_js_1.McpServer({
    name: "common-context-mcp",
    version: "1.0.0",
}, {
    instructions: `CRITICAL PROTOCOL — YOU MUST FOLLOW THIS EXACTLY:

1. FIRST ACTION: Call load_context() before ANY other work. MANDATORY. No exceptions.
   - If an interrupted session is found, resume from its checkpoint.
   - If no interrupted session, start fresh.

2. DURING WORK: Call save_context() after EVERY meaningful step.
   - This is your CHECKPOINT. If you get cut off, this is what survives.
   - Do NOT batch saves. Save frequently. Every decision, every fact, every config.
   - Call search_context() before any new approach to check if it was tried before.

3. ON ANY FAILURE: Call save_failure() IMMEDIATELY before trying alternatives.
   - Record what failed and why. Do not skip this.

4. ON IMPORTANT DECISIONS: Call broadcast() to notify other agents.

5. BEFORE FINISHING: Call save_summary() — THIS IS MANDATORY.
   - You CANNOT give your final response without calling this first.
   - The server will confirm "Summary saved. You may now respond."
   - Only then give your summary to the user.

6. IF YOU SENSE YOUR SESSION IS ENDING (token limit, user says stop, etc.):
   - Call save_summary() IMMEDIATELY with everything done so far.
   - Tell the user: "Progress saved to shared context. Switch to another agent to continue."
   - Do NOT try to continue working.

7. NEVER attempt a known-failed approach without checking search_context() first.

8. All MCP calls are visible to the user. Be transparent.

This MCP is your shared nervous system. Every agent reads from and writes to it. What you record here, the next agent inherits. What you fail to record, the next agent repeats. If you get cut off mid-work, your last save_context() is the checkpoint the next agent resumes from.`,
});
// ─── Tool 1: load_context ──────────────────────────────────
server.tool("load_context", "Load ALL shared context at session start. MUST be called first. Checks for interrupted sessions to resume from.", {}, async () => {
    const data = loadData();
    sessionLoaded = true;
    sessionCompleted = false;
    // Mark any previous active/checkpointed sessions as interrupted
    for (const s of data.sessions) {
        if (s.status === "active" || s.status === "checkpointed") {
            s.status = "interrupted";
            s.interrupted_at = now();
            if (!s.checkpoint) {
                s.checkpoint = "Session ended without save_summary. Last save_context was the last checkpoint.";
            }
        }
    }
    // Create a new active session for this agent
    const newSession = {
        id: `session-${data.sessions.length + 1}`,
        title: "In progress...",
        status: "active",
        accomplished: "",
        learned: "",
        decisions: "",
        next_steps: "",
        checkpoint: "Session started",
        agent: agentId,
        timestamp: now(),
    };
    data.sessions.push(newSession);
    saveData(data);
    const sections = [];
    sections.push("=== SHARED CONTEXT LOADED ===");
    sections.push(`Sessions: ${data.sessions.length}`);
    sections.push(`Failures recorded: ${data.failures.length}`);
    sections.push(`Context entries: ${Object.keys(data.contexts).length}`);
    sections.push(`Patterns: ${data.patterns.works.length} work, ${data.patterns.fails.length} fail`);
    sections.push("");
    // Check for interrupted sessions (excluding the one we just created)
    const interrupted = data.sessions.filter(s => (s.status === "interrupted" || s.status === "checkpointed") && s.id !== newSession.id);
    if (interrupted.length > 0) {
        sections.push("⚠️ INTERRUPTED SESSIONS DETECTED:");
        for (const s of interrupted) {
            sections.push(`  [${s.id}] "${s.title}" by ${s.agent}`);
            sections.push(`  Status: ${s.status}`);
            sections.push(`  Last checkpoint: ${s.checkpoint || s.accomplished || "none"}`);
            sections.push(`  Next steps: ${s.next_steps || "none"}`);
            sections.push(`  Interrupted at: ${s.interrupted_at || s.timestamp}`);
            sections.push("");
        }
        sections.push("You may want to resume one of these sessions or start fresh.");
        sections.push("");
    }
    if (Object.keys(data.contexts).length > 0) {
        sections.push("--- CONTEXT ENTRIES ---");
        for (const [key, entry] of Object.entries(data.contexts)) {
            sections.push(`[${key}] ${entry.value} (tags: ${entry.tags.join(", ")}) [by ${entry.agent}]`);
        }
        sections.push("");
    }
    if (data.sessions.length > 0) {
        sections.push("--- SESSION HISTORY ---");
        for (const s of data.sessions) {
            sections.push(`[${s.id}] ${s.title} (${s.status}) by ${s.agent} at ${s.timestamp}`);
            sections.push(`  Accomplished: ${s.accomplished}`);
            sections.push(`  Learned: ${s.learned}`);
            sections.push(`  Decisions: ${s.decisions}`);
            sections.push(`  Next steps: ${s.next_steps}`);
            if (s.checkpoint)
                sections.push(`  Checkpoint: ${s.checkpoint}`);
        }
        sections.push("");
    }
    if (data.failures.length > 0) {
        sections.push("--- FAILURE RECORDS (DO NOT REPEAT) ---");
        for (const f of data.failures) {
            sections.push(`[${f.approach}] ${f.why_failed} (by ${f.agent}, ${f.timestamp})`);
        }
        sections.push("");
    }
    if (data.broadcasts.length > 0) {
        sections.push("--- BROADCASTS ---");
        for (const b of data.broadcasts) {
            sections.push(`[${b.agent}] ${b.message} (${b.timestamp})`);
        }
        sections.push("");
    }
    if (data.patterns.works.length > 0 || data.patterns.fails.length > 0) {
        sections.push("--- PATTERNS ---");
        if (data.patterns.works.length > 0)
            sections.push(`Works: ${data.patterns.works.join(", ")}`);
        if (data.patterns.fails.length > 0)
            sections.push(`Fails: ${data.patterns.fails.join(", ")}`);
        sections.push("");
    }
    if (Object.keys(data.claims).length > 0) {
        sections.push("--- ACTIVE CLAIMS ---");
        for (const [area, claim] of Object.entries(data.claims)) {
            sections.push(`${area} → claimed by ${claim.agent} (since ${claim.since})`);
        }
        sections.push("");
    }
    sections.push("=== END OF CONTEXT ===");
    sections.push("You now have full shared knowledge. Proceed with your work.");
    return { content: [{ type: "text", text: sections.join("\n") }] };
});
// ─── Tool 2: save_context ──────────────────────────────────
server.tool("save_context", "Save a context entry (fact, decision, config). This is also a CHECKPOINT — if you get cut off, this survives. Requires load_context() first. Call frequently.", {
    key: zod_1.z.string().describe("Unique key for this context entry"),
    value: zod_1.z.string().describe("The value/content to store"),
    tags: zod_1.z.array(zod_1.z.string()).optional().describe("Tags for categorization"),
}, async ({ key, value, tags }) => {
    const err = requireLoaded();
    if (err)
        return { content: [{ type: "text", text: err }] };
    const data = loadData();
    data.contexts[key] = {
        value,
        tags: tags || [],
        agent: agentId,
        updated: now(),
    };
    // Auto-checkpoint: update the current session's checkpoint
    const activeSession = data.sessions.find(s => s.id === data.sessions[data.sessions.length - 1].id && (s.status === "active" || s.status === "checkpointed"));
    if (activeSession) {
        activeSession.checkpoint = `Last saved: ${key} = ${value}`;
        activeSession.status = "checkpointed";
    }
    saveData(data);
    return { content: [{ type: "text", text: `Saved context: ${key} = ${value} (checkpoint recorded)` }] };
});
// ─── Tool 3: save_summary ─────────────────────────────────
server.tool("save_summary", "Save session summary at end of work. MANDATORY before giving final response. Marks session as complete. Requires load_context() first.", {
    title: zod_1.z.string().describe("Session title"),
    accomplished: zod_1.z.string().describe("What was accomplished"),
    learned: zod_1.z.string().describe("What was learned"),
    decisions: zod_1.z.string().describe("Key decisions made"),
    next_steps: zod_1.z.string().describe("Next steps for future agents"),
}, async ({ title, accomplished, learned, decisions, next_steps }) => {
    const err = requireLoaded();
    if (err)
        return { content: [{ type: "text", text: err }] };
    const data = loadData();
    // Find the current session (last one, which should be active/checkpointed)
    const existingSession = data.sessions.find(s => s.id === data.sessions[data.sessions.length - 1].id && (s.status === "active" || s.status === "checkpointed" || s.status === "interrupted"));
    if (existingSession) {
        existingSession.title = title;
        existingSession.status = "completed";
        existingSession.accomplished = accomplished;
        existingSession.learned = learned;
        existingSession.decisions = decisions;
        existingSession.next_steps = next_steps;
        existingSession.checkpoint = "Session completed";
        existingSession.timestamp = now();
    }
    else {
        const session = {
            id: `session-${data.sessions.length + 1}`,
            title,
            status: "completed",
            accomplished,
            learned,
            decisions,
            next_steps,
            checkpoint: "Session completed",
            agent: agentId,
            timestamp: now(),
        };
        data.sessions.push(session);
    }
    // Update patterns
    // (agent can also call save_context with pattern info)
    saveData(data);
    sessionCompleted = true;
    return { content: [{ type: "text", text: `Session summary saved. You may now give your final response to the user.` }] };
});
// ─── Tool 4: save_failure ─────────────────────────────────
server.tool("save_failure", "Record a failed approach IMMEDIATELY when something doesn't work. Requires load_context() first.", {
    approach: zod_1.z.string().describe("What was attempted"),
    why_failed: zod_1.z.string().describe("Why it failed"),
}, async ({ approach, why_failed }) => {
    const err = requireLoaded();
    if (err)
        return { content: [{ type: "text", text: err }] };
    const data = loadData();
    data.failures.push({
        approach,
        why_failed,
        agent: agentId,
        timestamp: now(),
    });
    if (!data.patterns.fails.includes(approach)) {
        data.patterns.fails.push(approach);
    }
    // Checkpoint
    const activeSession = data.sessions.find(s => s.status === "active" || s.status === "checkpointed");
    if (activeSession) {
        activeSession.checkpoint = `Failed: ${approach} → ${why_failed}`;
        activeSession.status = "checkpointed";
    }
    saveData(data);
    return { content: [{ type: "text", text: `Failure recorded: ${approach} → ${why_failed}. Next agent will see this.` }] };
});
// ─── Tool 5: search_context ───────────────────────────────
server.tool("search_context", "Search all shared context by keyword. Requires load_context() first.", {
    query: zod_1.z.string().describe("Search query"),
}, async ({ query }) => {
    const err = requireLoaded();
    if (err)
        return { content: [{ type: "text", text: err }] };
    const data = loadData();
    const q = query.toLowerCase();
    const results = [];
    for (const [key, entry] of Object.entries(data.contexts)) {
        if (key.toLowerCase().includes(q) || entry.value.toLowerCase().includes(q) || entry.tags.some(t => t.toLowerCase().includes(q))) {
            results.push(`[context:${key}] ${entry.value}`);
        }
    }
    for (const s of data.sessions) {
        if (s.title.toLowerCase().includes(q) || s.accomplished.toLowerCase().includes(q) || s.learned.toLowerCase().includes(q) || s.decisions.toLowerCase().includes(q) || s.checkpoint.toLowerCase().includes(q)) {
            results.push(`[session:${s.id}] ${s.title} (${s.status}): ${s.accomplished}`);
        }
    }
    for (const f of data.failures) {
        if (f.approach.toLowerCase().includes(q) || f.why_failed.toLowerCase().includes(q)) {
            results.push(`[failure] ${f.approach}: ${f.why_failed}`);
        }
    }
    for (const b of data.broadcasts) {
        if (b.message.toLowerCase().includes(q)) {
            results.push(`[broadcast] ${b.message}`);
        }
    }
    if (results.length === 0) {
        return { content: [{ type: "text", text: `No results found for "${query}".` }] };
    }
    return { content: [{ type: "text", text: `Found ${results.length} results:\n${results.join("\n")}` }] };
});
// ─── Tool 6: claim_area ───────────────────────────────────
server.tool("claim_area", "Claim a file/area to prevent other agents from working on it. Requires load_context() first.", {
    area: zod_1.z.string().describe("File path or area to claim"),
}, async ({ area }) => {
    const err = requireLoaded();
    if (err)
        return { content: [{ type: "text", text: err }] };
    const data = loadData();
    if (data.claims[area] && data.claims[area].agent !== agentId) {
        const claim = data.claims[area];
        return { content: [{ type: "text", text: `Area ${area} is already claimed by ${claim.agent} since ${claim.since}. Choose a different area.` }] };
    }
    data.claims[area] = {
        agent: agentId,
        since: now(),
        expires: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };
    saveData(data);
    return { content: [{ type: "text", text: `Claimed: ${area}. Other agents will see this.` }] };
});
// ─── Tool 7: release_area ─────────────────────────────────
server.tool("release_area", "Release a claimed area. Requires load_context() first.", {
    area: zod_1.z.string().describe("File path or area to release"),
}, async ({ area }) => {
    const err = requireLoaded();
    if (err)
        return { content: [{ type: "text", text: err }] };
    const data = loadData();
    if (data.claims[area] && data.claims[area].agent === agentId) {
        delete data.claims[area];
        saveData(data);
        return { content: [{ type: "text", text: `Released: ${area}` }] };
    }
    return { content: [{ type: "text", text: `Area ${area} was not claimed by you.` }] };
});
// ─── Tool 8: list_claims ──────────────────────────────────
server.tool("list_claims", "List all currently claimed areas. Requires load_context() first.", {}, async () => {
    const err = requireLoaded();
    if (err)
        return { content: [{ type: "text", text: err }] };
    const data = loadData();
    const claims = Object.entries(data.claims);
    if (claims.length === 0) {
        return { content: [{ type: "text", text: "No areas currently claimed." }] };
    }
    const lines = claims.map(([area, claim]) => `${area} → ${claim.agent} (since ${claim.since})`);
    return { content: [{ type: "text", text: `Active claims:\n${lines.join("\n")}` }] };
});
// ─── Tool 9: broadcast ────────────────────────────────────
server.tool("broadcast", "Broadcast a decision/message to all agents. Requires load_context() first.", {
    message: zod_1.z.string().describe("Message to broadcast to all agents"),
}, async ({ message }) => {
    const err = requireLoaded();
    if (err)
        return { content: [{ type: "text", text: err }] };
    const data = loadData();
    data.broadcasts.push({
        message,
        agent: agentId,
        timestamp: now(),
    });
    saveData(data);
    return { content: [{ type: "text", text: `Broadcast sent: ${message}` }] };
});
// ─── Tool 10: handoff ─────────────────────────────────────
server.tool("handoff", "Transfer work to another agent with full context. Requires load_context() first.", {
    to_agent: zod_1.z.string().describe("Target agent identifier"),
    summary: zod_1.z.string().describe("What's being handed off"),
    context: zod_1.z.string().describe("Full context for the receiving agent"),
}, async ({ to_agent, summary, context }) => {
    const err = requireLoaded();
    if (err)
        return { content: [{ type: "text", text: err }] };
    const data = loadData();
    data.sessions.push({
        id: `handoff-${data.sessions.length + 1}`,
        title: `Handoff to ${to_agent}: ${summary}`,
        status: "completed",
        accomplished: context,
        learned: "",
        decisions: summary,
        next_steps: `Continue from: ${summary}`,
        checkpoint: "Handoff complete",
        agent: agentId,
        timestamp: now(),
    });
    data.broadcasts.push({
        message: `HANDOFF to ${to_agent}: ${summary}`,
        agent: agentId,
        timestamp: now(),
    });
    saveData(data);
    return { content: [{ type: "text", text: `Handoff recorded for ${to_agent}. Context saved for next agent.` }] };
});
// ─── Tool 11: get_patterns ────────────────────────────────
server.tool("get_patterns", "Get learned patterns (what works and what fails). Requires load_context() first.", {}, async () => {
    const err = requireLoaded();
    if (err)
        return { content: [{ type: "text", text: err }] };
    const data = loadData();
    const lines = [];
    lines.push("=== LEARNED PATTERNS ===");
    if (data.patterns.works.length > 0) {
        lines.push(`Works: ${data.patterns.works.join(", ")}`);
    }
    else {
        lines.push("Works: (none yet)");
    }
    if (data.patterns.fails.length > 0) {
        lines.push(`Fails: ${data.patterns.fails.join(", ")}`);
    }
    else {
        lines.push("Fails: (none yet)");
    }
    lines.push("");
    lines.push(`Total failures recorded: ${data.failures.length}`);
    lines.push(`Total sessions: ${data.sessions.length}`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
});
// ─── Tool 12: get_audit_trail ─────────────────────────────
server.tool("get_audit_trail", "Get full audit trail of all decisions, failures, and sessions. Requires load_context() first.", {}, async () => {
    const err = requireLoaded();
    if (err)
        return { content: [{ type: "text", text: err }] };
    const data = loadData();
    const lines = [];
    lines.push("=== AUDIT TRAIL ===");
    lines.push(`Created: ${data.created}`);
    lines.push(`Context entries: ${Object.keys(data.contexts).length}`);
    lines.push(`Sessions: ${data.sessions.length}`);
    lines.push(`Failures: ${data.failures.length}`);
    lines.push(`Broadcasts: ${data.broadcasts.length}`);
    lines.push(`Claims: ${Object.keys(data.claims).length}`);
    lines.push("");
    if (data.sessions.length > 0) {
        lines.push("--- SESSIONS ---");
        for (const s of data.sessions) {
            lines.push(`[${s.id}] ${s.title} (${s.status}) by ${s.agent} at ${s.timestamp}`);
        }
        lines.push("");
    }
    if (data.failures.length > 0) {
        lines.push("--- FAILURES ---");
        for (const f of data.failures) {
            lines.push(`[${f.approach}] ${f.why_failed} by ${f.agent} at ${f.timestamp}`);
        }
        lines.push("");
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
});
// ─── Tool 13: resume_session ──────────────────────────────
server.tool("resume_session", "Resume from an interrupted session. Loads checkpoint and marks session as active again. Requires load_context() first.", {
    session_id: zod_1.z.string().describe("Session ID to resume (from load_context output)"),
}, async ({ session_id }) => {
    const err = requireLoaded();
    if (err)
        return { content: [{ type: "text", text: err }] };
    const data = loadData();
    const session = data.sessions.find(s => s.id === session_id);
    if (!session) {
        return { content: [{ type: "text", text: `Session ${session_id} not found.` }] };
    }
    session.status = "active";
    session.checkpoint = `Resumed at ${now()}`;
    saveData(data);
    const lines = [];
    lines.push(`=== RESUMING SESSION: ${session.title} ===`);
    lines.push(`Last checkpoint: ${session.checkpoint}`);
    lines.push(`Accomplished so far: ${session.accomplished}`);
    lines.push(`Learned so far: ${session.learned}`);
    lines.push(`Decisions so far: ${session.decisions}`);
    lines.push(`Next steps: ${session.next_steps}`);
    lines.push("");
    lines.push("Continue from where the previous agent left off.");
    return { content: [{ type: "text", text: lines.join("\n") }] };
});
// ─── Tool 14: session_status ──────────────────────────────
server.tool("session_status", "Check current session health. Returns stats about context size, session age, and whether to wrap up. Requires load_context() first.", {}, async () => {
    const err = requireLoaded();
    if (err)
        return { content: [{ type: "text", text: err }] };
    const data = loadData();
    const fileSize = fs.statSync(CONTEXT_FILE).size;
    const sessionCount = data.sessions.length;
    const failureCount = data.failures.length;
    const contextCount = Object.keys(data.contexts).length;
    const broadcastCount = data.broadcasts.length;
    const lines = [];
    lines.push("=== SESSION STATUS ===");
    lines.push(`Context file size: ${fileSize} bytes`);
    lines.push(`Sessions: ${sessionCount}`);
    lines.push(`Failures: ${failureCount}`);
    lines.push(`Context entries: ${contextCount}`);
    lines.push(`Broadcasts: ${broadcastCount}`);
    lines.push(`Agent ID: ${agentId}`);
    lines.push(`Session loaded: ${sessionLoaded}`);
    lines.push(`Session completed: ${sessionCompleted}`);
    // Check for interrupted sessions
    const interrupted = data.sessions.filter(s => s.status === "interrupted");
    if (interrupted.length > 0) {
        lines.push("");
        lines.push(`⚠️ ${interrupted.length} interrupted session(s) need attention`);
    }
    // Estimate context size for the agent
    const contextText = JSON.stringify(data);
    const estimatedTokens = Math.ceil(contextText.length / 4);
    lines.push("");
    lines.push(`Estimated context size: ~${estimatedTokens} tokens`);
    if (estimatedTokens > 50000) {
        lines.push("⚠️ WARNING: Context is large. Consider wrapping up soon.");
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
});
// ─── Start Server ─────────────────────────────────────────
async function main() {
    const transport = new stdio_js_1.StdioServerTransport();
    await server.connect(transport);
    console.error("Common Context MCP server running on stdio");
}
main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
