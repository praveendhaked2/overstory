import type { SessionInfo } from "./sessions.ts";

/** running: working on a turn · waiting: needs you (a question or a permission prompt) · idle: turn finished, or the agent isn't running */
export type Activity = "running" | "waiting" | "idle";

export interface ProcessSignals {
  /** true/false when the agent process is known; undefined when it can't be found (started elsewhere). */
  alive?: boolean;
  /** Whether the agent is executing a shell command; undefined when unknown. */
  toolRunning?: boolean;
}

/** Tools whose whole purpose is to ask the user something. */
const ASK_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode", "request_user_input", "request_user_input_async"]);
/** Tools that run a shell command; while one is pending, a running command process means "running", none means "waiting for approval". */
const COMMAND_TOOLS = new Set(["Bash", "exec", "shell", "exec_command", "local_shell_call"]);
/** Claude tools that legitimately take a while without writing to the session file. */
const SLOW_CLAUDE_TOOLS = new Set(["Task", "Agent", "WebFetch", "WebSearch", "Workflow", "BashOutput", "Monitor", "TaskOutput"]);

/** A pending tool with no session-file writes for this long is treated as held at a prompt. */
export const QUIET_MS = 4000;
/** An open turn with no writes for this long, from an agent we can't see, counts as abandoned. */
export const STALE_MS = 10 * 60 * 1000;

export function sessionActivity(s: SessionInfo, proc: ProcessSignals, now = Date.now()): Activity {
  if (proc.alive === false || !s.turnOpen) return "idle";
  const quietFor = now - s.mtimeMs;
  if (proc.alive === undefined && quietFor > STALE_MS) return "idle";
  const pending = s.pendingTools;
  if (pending.some(n => ASK_TOOLS.has(n))) return "waiting";
  if (!pending.length || quietFor < QUIET_MS) return "running";
  if (pending.some(n => COMMAND_TOOLS.has(n))) return proc.toolRunning === false ? "waiting" : "running";
  if (s.agent === "codex") return "running";
  if (pending.every(n => SLOW_CLAUDE_TOOLS.has(n) || n.startsWith("mcp__"))) return "running";
  // Edit, Write and similar finish instantly; still pending after a few quiet seconds means a permission prompt.
  return "waiting";
}
