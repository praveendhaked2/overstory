import * as vscode from "vscode";
import { shellQuote } from "./core/paths.ts";
import { findAgentUnder, processTable, type ProcessTable } from "./core/processes.ts";
import type { Agent, SessionInfo } from "./core/sessions.ts";

export const sessionKey = (agent: Agent, id: string) => `${agent}:${id}`;

const ENV_KEY = "WORKTREE_SESSIONS_KEY";
const TOKENS_STATE = "worktreeSessions.pendingTokens";

interface PendingNew {
  token: string;
  agent: Agent;
  cwd: string;
  startedMs: number;
  terminal: vscode.Terminal;
}

/**
 * Owns the terminals this extension opens. Each terminal is tied to one session through its
 * name ("… · 1a2b3c4d") and an env var, so they can be found again after a window reload.
 */
export class TerminalManager implements vscode.Disposable {
  private byKey = new Map<string, vscode.Terminal>();
  /** Terminals adopted at startup whose session is only known by a short id or token until the next scan. */
  private unresolved = new Map<vscode.Terminal, string>();
  /** New Codex terminals, matched to their session file once Codex creates it. */
  private pendingNew: PendingNew[] = [];
  private disposables: vscode.Disposable[] = [];
  /** Agent pid per terminal (-1: alive but unknown, undefined: not running). */
  private agentPids = new Map<vscode.Terminal, number | undefined>();
  readonly onDidChange = new vscode.EventEmitter<void>();
  private state: vscode.Memento;

  constructor(state: vscode.Memento) {
    this.state = state;
    for (const t of vscode.window.terminals) this.adopt(t);
    this.disposables.push(
      vscode.window.onDidOpenTerminal(t => {
        if (!this.isOurs(t)) this.adopt(t);
      }),
      vscode.window.onDidCloseTerminal(t => {
        let changed = this.unresolved.delete(t);
        for (const [k, v] of this.byKey) if (v === t) { this.byKey.delete(k); changed = true; }
        this.pendingNew = this.pendingNew.filter(p => p.terminal !== t);
        this.agentPids.delete(t);
        if (changed) this.onDidChange.fire();
      }),
      this.onDidChange,
    );
  }

  private isOurs(t: vscode.Terminal): boolean {
    return [...this.byKey.values()].includes(t) || this.unresolved.has(t) || this.pendingNew.some(p => p.terminal === t);
  }

  private adopt(t: vscode.Terminal): void {
    const env = (t.creationOptions as vscode.TerminalOptions).env ?? {};
    const key = env[ENV_KEY];
    if (typeof key === "string" && key.includes(":") && !key.includes(":new-")) {
      this.byKey.set(key, t);
      return;
    }
    const m = / · ([0-9a-f]{8}|new-[0-9a-z]{6})$/.exec(t.name);
    if (m) this.unresolved.set(t, m[1]);
  }

  /** Links adopted and newly started terminals to the sessions found on disk. */
  resolve(sessions: SessionInfo[]): void {
    let changed = false;
    const tokens = this.state.get<Record<string, string>>(TOKENS_STATE, {});
    for (const [t, short] of this.unresolved) {
      const key = short.startsWith("new-")
        ? tokens[short]
        : (() => {
            const s = sessions.find(x => x.id.startsWith(short));
            return s && sessionKey(s.agent, s.id);
          })();
      if (key && !this.byKey.has(key)) {
        this.byKey.set(key, t);
        this.unresolved.delete(t);
        changed = true;
      }
    }
    for (const p of [...this.pendingNew]) {
      const taken = new Set(this.byKey.keys());
      const match = sessions
        .filter(s => s.agent === p.agent && s.cwd === p.cwd && s.createdMs >= p.startedMs - 5000 && !taken.has(sessionKey(s.agent, s.id)))
        .sort((a, b) => a.createdMs - b.createdMs)[0];
      if (match) {
        const key = sessionKey(match.agent, match.id);
        this.byKey.set(key, p.terminal);
        this.pendingNew = this.pendingNew.filter(x => x !== p);
        void this.state.update(TOKENS_STATE, { ...this.state.get<Record<string, string>>(TOKENS_STATE, {}), [p.token]: key });
        changed = true;
      }
    }
    if (changed) this.onDidChange.fire();
  }

  get(key: string): vscode.Terminal | undefined {
    return this.byKey.get(key);
  }

  attachedKeys(): string[] {
    return [...this.byKey.keys()];
  }

  /** Re-reads which terminals still have their agent running. */
  async refreshAlive(table: ProcessTable | undefined): Promise<void> {
    await Promise.all([...this.byKey.entries()].map(async ([key, t]) => {
      this.agentPids.set(t, await agentPidIn(t, key.split(":")[0] as Agent, table));
    }));
  }

  isAlive(key: string): boolean {
    const t = this.byKey.get(key);
    return !!t && this.agentPids.get(t) !== undefined;
  }

  /** The agent's pid in this session's terminal; -1 when alive but the pid can't be read. */
  agentPid(key: string): number | undefined {
    const t = this.byKey.get(key);
    return t ? this.agentPids.get(t) : undefined;
  }

  /** Focuses the session's terminal, starting `command` in it (or in a new terminal) if the agent isn't running. */
  async open(opts: { key: string; name: string; cwd: string; command: string; agent: Agent }): Promise<"focused" | "resumed" | "started"> {
    const existing = this.byKey.get(opts.key);
    if (existing) {
      const pid = await agentPidIn(existing, opts.agent);
      this.agentPids.set(existing, pid);
      const alive = pid !== undefined;
      if (!alive) existing.sendText(`cd ${shellQuote(opts.cwd)} && ${opts.command}`);
      existing.show(false);
      return alive ? "focused" : "resumed";
    }
    const t = this.create(opts.name, opts.cwd, opts.key, opts.agent);
    this.byKey.set(opts.key, t);
    t.sendText(opts.command);
    t.show(false);
    this.agentPids.set(t, -1);
    this.onDidChange.fire();
    return "started";
  }

  /** Starts an agent whose session id isn't known yet (Codex). It is linked on a later scan. */
  startUnlinked(opts: { name: string; cwd: string; command: string; agent: Agent }): void {
    const token = "new-" + Math.random().toString(36).slice(2, 8).padEnd(6, "0");
    const t = this.create(`${opts.name} · ${token}`, opts.cwd, `${opts.agent}:${token}`, opts.agent, true);
    this.pendingNew.push({ token, agent: opts.agent, cwd: opts.cwd, startedMs: Date.now(), terminal: t });
    t.sendText(opts.command);
    t.show(false);
    this.onDidChange.fire();
  }

  private create(name: string, cwd: string, key: string, agent: Agent, rawName = false): vscode.Terminal {
    const short = key.split(":")[1].slice(0, 8);
    return vscode.window.createTerminal({
      name: rawName ? name : `${name} · ${short}`,
      cwd,
      env: { [ENV_KEY]: key },
      iconPath: new vscode.ThemeIcon(agent === "claude" ? "sparkle" : "terminal"),
      color: new vscode.ThemeColor(agent === "claude" ? "terminal.ansiYellow" : "terminal.ansiCyan"),
      isTransient: false,
    });
  }

  close(key: string): void {
    const t = this.byKey.get(key);
    if (!t) return;
    this.byKey.delete(key);
    t.dispose();
    this.onDidChange.fire();
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}

/** The agent process running under the terminal's shell, if any. */
async function agentPidIn(t: vscode.Terminal, agent: Agent, table?: ProcessTable): Promise<number | undefined> {
  if (t.exitStatus) return undefined;
  let pid: number | undefined;
  try {
    pid = await Promise.race([t.processId, new Promise<undefined>(r => setTimeout(() => r(undefined), 1500))]);
  } catch {
    pid = undefined;
  }
  if (!pid) return undefined;
  table ??= await processTable();
  // Without a process table (Windows), an open terminal counts as running; -1 marks "alive, pid unknown".
  if (!table) return -1;
  return findAgentUnder(table, pid, agent);
}
