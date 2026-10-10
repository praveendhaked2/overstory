import { execFile } from "node:child_process";
import type { Agent } from "./sessions.ts";

export interface Proc {
  ppid: number;
  command: string;
}

export type ProcessTable = Map<number, Proc>;

/** One `ps` call per refresh. Undefined on Windows or when ps fails. */
export function processTable(): Promise<ProcessTable | undefined> {
  if (process.platform === "win32") return Promise.resolve(undefined);
  return new Promise(resolve => {
    execFile("ps", ["-A", "-o", "pid=,ppid=,command="], { timeout: 4000, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve(undefined);
      resolve(parsePs(String(out)));
    });
  });
}

export function parsePs(out: string): ProcessTable {
  const table: ProcessTable = new Map();
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) table.set(+m[1], { ppid: +m[2], command: m[3] });
  }
  return table;
}

const AGENT_RE: Record<Agent, RegExp> = {
  claude: /(^|[\/\s])claude(\s|$)/,
  codex: /(^|[\/\s])codex(\s|$)/,
};

/** A shell running one of the agent's tool commands. Claude runs Bash via ~/.claude/shell-snapshots; Codex via `sh -lc`. */
const TOOL_RE: Record<Agent, RegExp> = {
  claude: /shell-snapshots/,
  codex: /(^|\/)(ba|z)?sh\s+-l?c\s/,
};

function descendants(table: ProcessTable, root: number): number[] {
  const children = new Map<number, number[]>();
  for (const [p, info] of table) {
    const list = children.get(info.ppid);
    if (list) list.push(p);
    else children.set(info.ppid, [p]);
  }
  const out: number[] = [];
  const stack = [...(children.get(root) ?? [])];
  while (stack.length) {
    const p = stack.pop()!;
    out.push(p);
    stack.push(...(children.get(p) ?? []));
  }
  return out;
}

/** The outermost `claude`/`codex` process below `root` (a terminal's shell). */
export function findAgentUnder(table: ProcessTable, root: number, agent: Agent): number | undefined {
  const matches = descendants(table, root).filter(p => AGENT_RE[agent].test(table.get(p)?.command ?? ""));
  return matches.find(p => !matches.includes(table.get(p)!.ppid)) ?? matches[0];
}

/** Whether the agent is executing a shell command right now (as opposed to waiting for approval to run one). */
export function isRunningTool(table: ProcessTable, agentPid: number, agent: Agent): boolean {
  return descendants(table, agentPid).some(p => TOOL_RE[agent].test(table.get(p)?.command ?? ""));
}

/** Agent processes started outside our terminals that name their session on the command line (`claude --resume <id>`, `codex resume <id>`). */
export function externalAgents(table: ProcessTable): Map<string, { pid: number; agent: Agent }> {
  const out = new Map<string, { pid: number; agent: Agent }>();
  const uuid = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
  const claudeRe = new RegExp(`(?:--resume|-r|--session-id)[ =]${uuid}`, "i");
  const codexRe = new RegExp(`\\bresume\\s+${uuid}`, "i");
  for (const [pid, p] of table) {
    if (AGENT_RE.claude.test(p.command)) {
      const m = claudeRe.exec(p.command);
      if (m && !out.has(m[1])) out.set(m[1], { pid, agent: "claude" });
    } else if (AGENT_RE.codex.test(p.command)) {
      const m = codexRe.exec(p.command);
      if (m && !out.has(m[1])) out.set(m[1], { pid, agent: "codex" });
    }
  }
  return out;
}
