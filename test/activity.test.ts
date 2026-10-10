import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionActivity } from "../src/core/activity.ts";
import { externalAgents, findAgentUnder, isRunningTool, parsePs } from "../src/core/processes.ts";
import { applyClaudeLine, applyCodexLine, type Parsed, type SessionInfo } from "../src/core/sessions.ts";

const L = (o: object) => JSON.stringify(o);
const now = 1_000_000_000_000;
const info = (p: Parsed, agent: "claude" | "codex", ageMs = 0): SessionInfo => ({
  agent, id: "x", file: "f", files: ["f"], cwd: "/r", title: "t", turns: p.turns, mtimeMs: now - ageMs, createdMs: 0,
  turnOpen: !!p.turnOpen, pendingTools: Object.values(p.pending ?? {}),
});
const claude = (...lines: object[]) => { const p: Parsed = { turns: 0 }; for (const l of lines) applyClaudeLine(p, L(l)); return p; };
const codex = (...lines: object[]) => { const p: Parsed = { turns: 0 }; for (const l of lines) applyCodexLine(p, L(l)); return p; };

const prompt = { type: "user", message: { content: "do the thing" } };
const toolUse = (id: string, name: string) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name }] } });
const toolResult = (id: string) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id }] } });
const turnEnd = { type: "system", subtype: "turn_duration" };

test("Claude: prompt then thinking is running; turn_duration is idle", () => {
  assert.equal(sessionActivity(info(claude(prompt), "claude"), {}, now), "running");
  assert.equal(sessionActivity(info(claude(prompt, { type: "assistant", message: { content: [{ type: "text", text: "done" }] } }, turnEnd), "claude"), {}, now), "idle");
});

test("Claude: AskUserQuestion pending is waiting; answered is running", () => {
  const p = claude(prompt, toolUse("a", "AskUserQuestion"));
  assert.equal(sessionActivity(info(p, "claude"), { alive: true }, now), "waiting");
  applyClaudeLine(p, L(toolResult("a")));
  assert.equal(sessionActivity(info(p, "claude"), { alive: true }, now), "running");
});

test("Claude: Bash pending is running while its command runs, waiting when held for approval", () => {
  const p = claude(prompt, toolUse("b", "Bash"));
  assert.equal(sessionActivity(info(p, "claude", 1000), { alive: true, toolRunning: false }, now), "running", "too soon to call it");
  assert.equal(sessionActivity(info(p, "claude", 10_000), { alive: true, toolRunning: true }, now), "running");
  assert.equal(sessionActivity(info(p, "claude", 10_000), { alive: true, toolRunning: false }, now), "waiting");
  assert.equal(sessionActivity(info(p, "claude", 10_000), {}, now), "running", "unknown process: assume running");
});

test("Claude: Edit still pending after a quiet moment is a permission prompt", () => {
  assert.equal(sessionActivity(info(claude(prompt, toolUse("e", "Edit")), "claude", 6000), { alive: true }, now), "waiting");
  assert.equal(sessionActivity(info(claude(prompt, toolUse("t", "Task")), "claude", 60_000), { alive: true }, now), "running");
});

test("Claude: interrupt ends the turn; dead process is idle; stale unknown is idle", () => {
  const p = claude(prompt, toolUse("b", "Bash"), { type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } });
  assert.equal(p.turns, 1, "interrupt marker isn't a prompt");
  assert.equal(sessionActivity(info(p, "claude"), { alive: true }, now), "idle");
  assert.equal(sessionActivity(info(claude(prompt), "claude"), { alive: false }, now), "idle");
  assert.equal(sessionActivity(info(claude(prompt), "claude", 11 * 60_000), {}, now), "idle");
  assert.equal(sessionActivity(info(claude(prompt), "claude", 11 * 60_000), { alive: true }, now), "running");
});

test("Codex: task_started/complete and request_user_input", () => {
  const started = { type: "event_msg", payload: { type: "task_started" } };
  const done = { type: "event_msg", payload: { type: "task_complete" } };
  const ask = { type: "response_item", payload: { type: "function_call", name: "request_user_input_async", call_id: "q" } };
  const exec = { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "c" } };
  const execOut = { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c" } };
  assert.equal(sessionActivity(info(codex(started), "codex"), {}, now), "running");
  assert.equal(sessionActivity(info(codex(started, ask), "codex"), {}, now), "waiting");
  assert.equal(sessionActivity(info(codex(started, exec), "codex", 10_000), { alive: true, toolRunning: false }, now), "waiting");
  assert.equal(sessionActivity(info(codex(started, exec, execOut), "codex", 10_000), { alive: true, toolRunning: false }, now), "running");
  assert.equal(sessionActivity(info(codex(started, exec, done), "codex"), {}, now), "idle");
  assert.equal(sessionActivity(info(codex(started, { type: "event_msg", payload: { type: "turn_aborted" } }), "codex"), {}, now), "idle");
});

test("process table: agent under a terminal shell, running tool, external sessions", () => {
  const t = parsePs([
    "  100     1 /bin/zsh -il",
    "  101   100 claude --resume 11111111-2222-3333-4444-555555555555",
    "  102   101 node /Users/me/.npm/graft-mcp/server.js",
    "  103   101 /bin/zsh -c source /Users/me/.claude/shell-snapshots/snapshot-zsh-1.sh && eval 'npm test'",
    "  200     1 /bin/zsh -il",
    "  201   200 node /Users/me/.nvm/bin/codex resume 01a11fdd-f17c-78f0-9d11-0d49f357fb52",
    "  202   201 /Users/me/.nvm/lib/codex/codex-aarch64 resume 01a11fdd-f17c-78f0-9d11-0d49f357fb52",
  ].join("\n"));
  assert.equal(findAgentUnder(t, 100, "claude"), 101);
  assert.equal(findAgentUnder(t, 200, "codex"), 201, "outermost codex process");
  assert.equal(isRunningTool(t, 101, "claude"), true);
  t.delete(103);
  assert.equal(isRunningTool(t, 101, "claude"), false, "an MCP server child isn't a running command");
  const ext = externalAgents(t);
  assert.equal(ext.get("11111111-2222-3333-4444-555555555555")?.pid, 101);
  assert.equal(ext.get("01a11fdd-f17c-78f0-9d11-0d49f357fb52")?.agent, "codex");
});
