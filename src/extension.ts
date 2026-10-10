import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { preserveIntoWorktree } from "./core/copyFiles.ts";
import {
  addWorktree,
  branchExists,
  commitsAhead,
  deleteBranch,
  dirtyCount,
  excludeFromGit,
  locateRepo,
  fetchAll,
  listBranches,
  refExists,
  GitError,
  isValidBranchName,
  pruneWorktrees,
  realpath,
  removeWorktree,
  unpushedCommits,
  upstreamOf,
  type Worktree,
} from "./core/git.ts";
import { shellQuote, tildify, timeAgo, worktreePathFor } from "./core/paths.ts";
import { sessionActivity, type ProcessSignals } from "./core/activity.ts";
import { externalAgents, isRunningTool, processTable, type ProcessTable } from "./core/processes.ts";
import { SessionScanner, type Agent, type SessionInfo } from "./core/sessions.ts";
import { autoBranchName } from "./core/names.ts";
import { pruneMemo, sortByState, type GroupMemo, type SortGroup } from "./core/sorting.ts";
import { folderLabel, WorkspaceModel, worktreeLabel, type Repo } from "./model.ts";
import { SessionsViewProvider } from "./sessionsView.ts";
import { sessionKey, TerminalManager } from "./terminals.ts";
import { openPreservePanel } from "./preservePanel.ts";
import { ANCHOR_NAME, ensureAnchorFolder, workspaceFolderEntries } from "./workspaceSetup.ts";
import type { DeleteInfo, DotState, Filter, FromWebview, MissingInfo, RepoView, SessionView, UiState } from "./types.ts";

const HIDDEN_STATE = "worktreeSessions.hidden";
const PINNED_STATE = "worktreeSessions.pinned";
const FILTER_STATE = "worktreeSessions.filter";
const ATTACHED_STATE = "worktreeSessions.lastAttached";
const UI_CACHE_STATE = "worktreeSessions.uiCache";
const PENDING_SWAP_STATE = "worktreeSessions.pendingSwap";
const ANCHOR_STATE = "worktreeSessions.anchorChoice";
const WORKSPACE_CHOICE_STATE = "worktreeSessions.workspaceChoice";
const WORKSPACE_BANNER_STATE = "worktreeSessions.workspaceBannerDismissed";
/** Survives reopening the window in a new workspace (global, keyed by the workspace file). */
const PENDING_GLOBAL = "worktreeSessions.pendingAfterReopen";

type PendingAction = { kind: "open"; key: string } | { kind: "new"; repoKey: string } | { kind: "swap"; repoKey: string; wtPath: string } | { kind: "none" };
const AGENT_NAME: Record<Agent, string> = { claude: "Claude Code", codex: "Codex" };
const FILTER_LABELS: Record<Filter, string> = { all: "All", active: "Active", claude: "Claude", codex: "Codex" };
const PICKER_PAGE = 5;

/** Returned from activate(); used by the end-to-end tests. */
export interface WorktreeSessionsApi {
  ready: Promise<void>;
  views(): RepoView[];
  refresh(): Promise<void>;
  deleteInfo(key: string): Promise<DeleteInfo | undefined>;
  performDelete(key: string, rmWt: boolean, rmBranch: boolean): Promise<string | undefined>;
  /** Tests replace the Worktree Files page, which can't be driven from outside its webview. */
  setPreservePicker(fn: typeof openPreservePanel): void;
}

export function activate(ctx: vscode.ExtensionContext): WorktreeSessionsApi {
  const c = new Controller(ctx);
  ctx.subscriptions.push(c);
  const ready = c.start();
  return {
    ready,
    views: () => c.currentViews(),
    refresh: () => c.refreshAllPublic(),
    deleteInfo: async key => {
      const v = c.findSession(key);
      return v && c.gatherDeleteInfo(v);
    },
    performDelete: async (key, rmWt, rmBranch) => {
      const v = c.findSession(key);
      return v ? c.performDelete(v, rmWt, rmBranch) : "not found";
    },
    setPreservePicker: fn => (c.preservePicker = fn),
  };
}

export function deactivate(): void {}

function cfg() {
  return vscode.workspace.getConfiguration("worktreeSessions");
}

/** Argument shapes commands receive: a webview context-menu payload, or an internal { view } / { repo } object. */
type CmdArg = { sessionKey?: string; repoKey?: string; view?: { key?: string; repo?: { key: string } }; kind?: string } | undefined;

class Controller implements vscode.Disposable {
  private ctx: vscode.ExtensionContext;
  private model = new WorkspaceModel();
  private scanner: SessionScanner;
  private terminals: TerminalManager;
  private provider: SessionsViewProvider;
  private status: vscode.StatusBarItem;
  private sessions: SessionInfo[] = [];
  private procs: ProcessTable | undefined;
  private external = new Map<string, { pid: number; agent: Agent }>();
  /** Each session's sort group and when it entered it, so the list only reorders on a state change. */
  private groupSince: GroupMemo = new Map();
  preservePicker = openPreservePanel;
  private views: RepoView[] = [];
  private filter: Filter;
  private selected: string | undefined;
  private banner: string | undefined;
  private firstScanDone = false;
  private lastSig = "";
  private disposables: vscode.Disposable[] = [];
  private scanning: Promise<void> | undefined;
  private scanAgain = false;
  private debounce: NodeJS.Timeout | undefined;

  constructor(ctx: vscode.ExtensionContext) {
    this.ctx = ctx;
    this.scanner = new SessionScanner({
      claudeHome: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
      codexHome: process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
      maxAgeDays: cfg().get<number>("maxAgeDays", 30),
    });
    this.terminals = new TerminalManager(ctx.workspaceState);
    const savedFilter = ctx.workspaceState.get<string>(FILTER_STATE, "all");
    this.filter = (savedFilter === "open" ? "active" : savedFilter) as Filter;
    this.provider = new SessionsViewProvider(ctx.extensionUri, m => void this.onMessage(m));
    // Paint the last known list right away, so an extension restart doesn't blank the sidebar.
    const cached = ctx.workspaceState.get<UiState>(UI_CACHE_STATE);
    if (cached) this.provider.setState({ ...cached, banner: undefined });
    this.status = vscode.window.createStatusBarItem("worktreeSessions.status", vscode.StatusBarAlignment.Left, 50);
    this.status.name = "Worktree Sessions";
    this.status.command = `${SessionsViewProvider.viewId}.focus`;

    const cmd = (id: string, fn: (...a: any[]) => unknown) =>
      vscode.commands.registerCommand(id, async (...a: any[]) => {
        try {
          await fn(...a);
        } catch (e) {
          void vscode.window.showErrorMessage(errorText(e));
        }
      });

    this.disposables.push(
      vscode.window.registerWebviewViewProvider(SessionsViewProvider.viewId, this.provider, { webviewOptions: { retainContextWhenHidden: true } }),
      this.status,
      this.terminals,
      cmd("worktreeSessions.refresh", () => this.refreshAll()),
      cmd("worktreeSessions.collapseAll", () => this.provider.post({ type: "collapseAll" })),
      cmd("worktreeSessions.newSession", () => this.newSession()),
      cmd("worktreeSessions.newSessionInRepo", (a: CmdArg) => this.newSession(this.repoOf(a))),
      cmd("worktreeSessions.openSession", (a: CmdArg) => this.openSession(this.sessionOf(a))),
      cmd("worktreeSessions.deleteSession", (a: CmdArg) => this.askDelete(this.sessionOf(a))),
      cmd("worktreeSessions.switchToPrimary", (a: CmdArg) => this.switchToPrimary(this.repoOf(a))),
      cmd("worktreeSessions.switchWorktree", (a: CmdArg) => this.switchWorktree(this.repoOf(a))),
      cmd("worktreeSessions.setFilter", () => this.pickFilter()),
      cmd("worktreeSessions.hideSession", (a: CmdArg) => this.hideSession(this.sessionOf(a))),
      cmd("worktreeSessions.pinSession", (a: CmdArg) => this.setPinned(this.sessionOf(a), true)),
      cmd("worktreeSessions.unpinSession", (a: CmdArg) => this.setPinned(this.sessionOf(a), false)),
      cmd("worktreeSessions.unhideAll", () => this.unhideAll()),
      cmd("worktreeSessions.createWorkspace", () => this.createWorkspace([], { kind: "none" })),
      cmd("worktreeSessions.addProject", () => this.addProjects()),
      cmd("worktreeSessions.configurePreserve", () => this.configurePreserve()),
      cmd("worktreeSessions.addPlaceholderFolder", async () => {
        await this.ctx.workspaceState.update(ANCHOR_STATE, undefined);
        if (!(await this.addPlaceholderFolder())) void vscode.window.showInformationMessage("The workspace already starts with the placeholder folder.");
      }),
      cmd("worktreeSessions.copySessionId", async (a: CmdArg) => {
        const v = this.sessionOf(a);
        if (v) await vscode.env.clipboard.writeText(v.s.id);
      }),
      cmd("worktreeSessions.revealSessionFile", async (a: CmdArg) => {
        const v = this.sessionOf(a);
        if (v) await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(v.s.file));
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.refreshAll()),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration("worktreeSessions")) {
          this.scanner.opts.maxAgeDays = cfg().get<number>("maxAgeDays", 30);
          void this.refreshSessions();
        }
      }),
      vscode.window.onDidChangeWindowState(s => {
        if (s.focused) void this.refreshAll();
      }),
      this.terminals.onDidChange.event(() => this.rebuild()),
    );

    for (const dir of [path.join(this.scanner.opts.claudeHome, "projects"), path.join(this.scanner.opts.codexHome, "sessions")]) {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), "**/*.jsonl"));
      const poke = () => this.scheduleScan();
      this.disposables.push(w, w.onDidChange(poke), w.onDidCreate(poke), w.onDidDelete(poke));
    }
    const fast = setInterval(() => void this.refreshSessions(), 4000);
    const slow = setInterval(() => void this.refreshModel().then(() => this.rebuild()), 30000);
    this.disposables.push({ dispose: () => (clearInterval(fast), clearInterval(slow)) });
  }

  async start(): Promise<void> {
    await this.refreshAll();
    await this.resumePendingSwap();
    await this.runPendingAfterReopen();
  }

  /** Continues what the user clicked before the window reopened in the workspace we created. */
  private async runPendingAfterReopen(): Promise<void> {
    const p = this.ctx.globalState.get<{ wsFile: string; at: number; action: PendingAction }>(PENDING_GLOBAL);
    if (!p) return;
    const fresh = Date.now() - p.at < 180000;
    if (fresh && vscode.workspace.workspaceFile?.fsPath !== p.wsFile) return; // meant for another window
    await this.ctx.globalState.update(PENDING_GLOBAL, undefined);
    if (!fresh) return;
    vscode.window.setStatusBarMessage(`$(check) Workspace ready: ${path.basename(p.wsFile)}`, 5000);
    const a = p.action;
    if (a.kind === "open") await this.openSession(this.findSession(a.key));
    else if (a.kind === "new") await this.newSession(this.model.repos.find(r => r.key === a.repoKey));
    else if (a.kind === "swap") {
      const repo = this.model.repos.find(r => r.key === a.repoKey);
      const wt = repo?.worktrees.find(w => w.path === a.wtPath);
      if (repo && wt) await this.swap(repo, wt);
    }
  }

  /** Finishes a swap that was interrupted by adding the placeholder folder (which restarts extensions). */
  private async resumePendingSwap(): Promise<void> {
    const p = this.ctx.workspaceState.get<{ repoKey: string; wtPath: string; at: number }>(PENDING_SWAP_STATE);
    if (!p) return;
    await this.ctx.workspaceState.update(PENDING_SWAP_STATE, undefined);
    if (Date.now() - p.at > 120000) return;
    const repo = this.model.repos.find(r => r.key === p.repoKey);
    const wt = repo?.worktrees.find(w => w.path === p.wtPath);
    if (repo && wt) await this.swap(repo, wt);
  }

  currentViews(): RepoView[] {
    return this.views;
  }

  refreshAllPublic(): Promise<void> {
    return this.refreshAll();
  }

  dispose(): void {
    clearTimeout(this.debounce);
    this.disposables.forEach(d => d.dispose());
  }

  // ---------- webview messages ----------

  private async onMessage(m: FromWebview): Promise<void> {
    try {
      switch (m.type) {
        case "open":
          return await this.openSession(this.findSession(m.key));
        case "delete":
          return await this.askDelete(this.findSession(m.key));
        case "confirmDelete": {
          const v = this.findSession(m.key);
          if (!v) return void this.provider.post({ type: "dialogDone", error: "This session no longer exists." });
          const error = await this.performDelete(v, m.rmWt, m.rmBranch);
          return void this.provider.post({ type: "dialogDone", error });
        }
        case "missingAction": {
          const v = this.findSession(m.key);
          if (!v) return void this.provider.post({ type: "dialogDone" });
          if (m.action === "hide") return await this.hideSession(v);
          try {
            await this.recreateWorktree(v);
            this.provider.post({ type: "dialogDone" });
          } catch (e) {
            this.provider.post({ type: "dialogDone", error: errorText(e) });
          }
          return;
        }
        case "new":
          return await this.newSession(m.repoKey ? this.model.repos.find(r => r.key === m.repoKey) : undefined);
        case "home":
          return await this.switchToPrimary(this.model.repos.find(r => r.key === m.repoKey));
        case "pin":
          return await this.setPinned(this.findSession(m.key), m.pinned);
        case "filter":
          return await this.setFilter(m.filter);
        case "createWorkspace":
          return void (await this.createWorkspace([], { kind: "none" }));
        case "addProject":
          return await this.addProjects();
        case "dismissWorkspaceBanner":
          await this.ctx.workspaceState.update(WORKSPACE_BANNER_STATE, true);
          this.lastSig = "";
          return this.rebuild();
        case "dismissBanner":
          this.banner = undefined;
          this.lastSig = "";
          return this.rebuild();
      }
    } catch (e) {
      void vscode.window.showErrorMessage(errorText(e));
    }
  }

  // ---------- data ----------

  private async refreshAll(): Promise<void> {
    await this.refreshModel();
    await this.refreshSessions();
  }

  private async refreshModel(): Promise<void> {
    try {
      await this.model.refresh();
    } catch (e) {
      console.error("[worktree-sessions] model refresh failed", e);
    }
  }

  private scheduleScan(): void {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.refreshSessions(), 400);
  }

  private refreshSessions(): Promise<void> {
    if (this.scanning) {
      this.scanAgain = true;
      return this.scanning;
    }
    this.scanning = (async () => {
      try {
        do {
          this.scanAgain = false;
          this.sessions = await this.scanner.scan(this.model.allWorktreePaths());
          this.terminals.resolve(this.sessions);
          this.procs = await processTable();
          this.external = this.procs ? externalAgents(this.procs) : new Map();
          await this.terminals.refreshAlive(this.procs);
          if (!this.firstScanDone) this.checkRestart();
          this.rebuild();
        } while (this.scanAgain);
      } catch (e) {
        console.error("[worktree-sessions] scan failed", e);
      } finally {
        this.scanning = undefined;
      }
    })();
    return this.scanning;
  }

  /** After a restart, say how many session terminals didn't come back. */
  private checkRestart(): void {
    this.firstScanDone = true;
    const before = this.ctx.workspaceState.get<number>(ATTACHED_STATE, 0);
    const now = this.terminals.attachedKeys().length;
    if (before > now) {
      const lost = before - now;
      this.banner = `VS Code restarted. ${lost} session${lost > 1 ? "s" : ""} had a terminal; the conversations are saved. Click a session to resume it in its worktree.`;
    }
  }

  private rebuild(): void {
    const hidden = new Set(this.ctx.workspaceState.get<string[]>(HIDDEN_STATE, []));
    const now = Date.now();
    const views: RepoView[] = this.model.repos.map(repo => ({ repo, sessions: [] }));
    for (const s of this.sessions) {
      const key = sessionKey(s.agent, s.id);
      if (hidden.has(key)) continue;
      const loc = this.model.locate(s.cwd);
      if (!loc) continue;
      const attached = !!this.terminals.get(key);
      const alive = this.terminals.isAlive(key);
      const activity = sessionActivity(s, this.processSignals(s, key, attached), now);
      views.find(v => v.repo === loc.repo)!.sessions.push({ s, key, repo: loc.repo, wt: loc.worktree, attached, alive, activity, missing: loc.worktree.prunable });
    }
    this.sortSessions(views, now);
    this.views = views;
    if (this.firstScanDone) {
      const attached = this.terminals.attachedKeys().length;
      if (this.ctx.workspaceState.get<number>(ATTACHED_STATE, 0) !== attached) void this.ctx.workspaceState.update(ATTACHED_STATE, attached);
    }

    const state = this.uiState(now);
    const sig = JSON.stringify(state);
    if (sig !== this.lastSig) {
      this.lastSig = sig;
      this.provider.setState(state);
      if (this.firstScanDone) void this.ctx.workspaceState.update(UI_CACHE_STATE, state);
    }
    this.updateStatus();
  }

  /**
   * Waiting for input first, then running, then open in a terminal but idle, then everything else.
   * Within the first three groups, the session that most recently entered its group comes first, so
   * the order changes only when a state changes, not on every file write. The rest go newest first.
   */
  private sortSessions(views: RepoView[], now: number): void {
    const groupOf = (v: SessionView): SortGroup => (v.missing ? 3 : v.activity === "waiting" ? 0 : v.activity === "running" ? 1 : v.alive ? 2 : 3);
    const seen = new Set<string>();
    for (const v of views) {
      const items = v.sessions.map(x => ({ key: x.key, group: groupOf(x), mtimeMs: x.s.mtimeMs, x }));
      items.forEach(i => seen.add(i.key));
      // Pinned sessions first (in the same state order), then the rest.
      const pinned = this.pinnedKeys();
      const sorted = sortByState(items, this.groupSince, now).map(i => i.x);
      v.sessions = [...sorted.filter(x => pinned.has(x.key)), ...sorted.filter(x => !pinned.has(x.key))];
    }
    pruneMemo(this.groupSince, seen);
  }

  /** What the process table says about a session's agent: ours (terminal) or one started elsewhere with its id on the command line. */
  private processSignals(s: SessionInfo, key: string, attached: boolean): ProcessSignals {
    let pid: number | undefined;
    if (attached) {
      pid = this.terminals.agentPid(key);
      if (pid === undefined) return { alive: false };
    } else {
      pid = this.external.get(s.id)?.pid;
      if (pid === undefined) return {};
    }
    if (pid === -1 || !this.procs) return { alive: true };
    return { alive: true, toolRunning: isRunningTool(this.procs, pid, s.agent) };
  }

  private uiState(now: number): UiState {
    const dot = (v: SessionView): DotState => (v.missing ? "missing" : v.activity);
    return {
      filter: this.filter,
      maxAgeDays: this.scanner.opts.maxAgeDays,
      selected: this.selected,
      banner: this.banner,
      noWorkspace: this.needsWorkspace() && this.model.repos.length > 0 && !this.ctx.workspaceState.get<boolean>(WORKSPACE_BANNER_STATE, false),
      repos: this.views.map(({ repo, sessions }) => ({
        key: repo.key,
        name: repo.name,
        currentLabel: worktreeLabel(repo.current),
        currentPrimary: repo.current.primary,
        primaryLabel: worktreeLabel(repo.primary),
        total: sessions.length,
        running: sessions.filter(s => s.activity === "running").length,
        waiting: sessions.filter(s => s.activity === "waiting").length,
        sessions: sessions.map(v => ({
          key: v.key,
          title: v.s.title,
          agent: v.s.agent,
          wtLabel: worktreeLabel(v.wt),
          wtPrimary: v.wt.primary,
          turns: v.s.turns,
          ago: timeAgo(v.s.mtimeMs, now),
          state: dot(v),
          inactive: repo.current.path !== v.wt.path,
          pinned: this.pinnedKeys().has(v.key),
          tooltip: `${v.s.title}\n${AGENT_NAME[v.s.agent]} · ${tildify(v.s.cwd)}\n${repo.current.path !== v.wt.path ? `Click to switch ${repo.name} to ${worktreeLabel(v.wt)} and resume` : v.alive ? "Click to focus its terminal" : "Click to resume in a terminal"}`,
        })),
      })),
    };
  }

  private updateStatus(): void {
    const all = this.views.flatMap(v => v.sessions);
    const running = all.filter(s => s.activity === "running").length;
    const waiting = all.filter(s => s.activity === "waiting").length;
    if (!running && !waiting) {
      this.status.hide();
      return;
    }
    this.status.backgroundColor = waiting ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    this.status.text = [running ? `$(loading~spin) ${running} running` : "", waiting ? `$(bell) ${waiting} waiting` : ""].filter(Boolean).join("  ");
    const open = running + waiting;
    const offPrimary = this.model.repos.filter(r => !r.current.primary).map(r => `${r.name} ${worktreeLabel(r.current)}`);
    this.status.tooltip = `Agent sessions running: ${running}, waiting for input: ${waiting}${offPrimary.length ? `\nRepos on a worktree: ${offPrimary.join(", ")}` : ""}`;
    this.status.show();
  }

  // ---------- lookups ----------

  findSession(key: string): SessionView | undefined {
    return this.views.flatMap(v => v.sessions).find(x => x.key === key);
  }

  private sessionOf(a: CmdArg): SessionView | undefined {
    const key = a?.sessionKey ?? a?.view?.key;
    return key ? this.findSession(key) : undefined;
  }

  private repoOf(a: CmdArg): Repo | undefined {
    const key = a?.repoKey ?? a?.view?.repo?.key ?? (a?.sessionKey ? this.findSession(a.sessionKey)?.repo.key : undefined);
    return key ? this.model.repos.find(r => r.key === key) : undefined;
  }

  private freshRepo(repo: Repo): Repo {
    return this.model.repos.find(r => r.key === repo.key) ?? repo;
  }

  private resumeCommand(s: SessionInfo): string {
    return s.agent === "claude"
      ? `${cfg().get<string>("claudeCommand", "claude")} --resume ${shellQuote(s.id)}`
      : `${cfg().get<string>("codexCommand", "codex")} resume ${shellQuote(s.id)}`;
  }

  private terminalName(agent: Agent, repo: Repo, wt: Worktree): string {
    return `${agent} · ${repo.name} ${worktreeLabel(wt)}`;
  }

  // ---------- workspace swapping ----------

  /** Points every workspace folder of `repo` at `target`. Other repos are untouched. */
  private async swap(repo: Repo, target: Worktree): Promise<boolean> {
    repo = this.freshRepo(repo);
    if (repo.current.path === target.path) return true;
    const plan = repo.folders.map(f => ({ f, dest: path.join(target.path, f.subpath) }));
    const absent = plan.find(p => !fs.existsSync(p.dest));
    if (absent) {
      void vscode.window.showWarningMessage(`${worktreeLabel(target)} has no “${absent.f.subpath || "."}” folder, so ${repo.name} wasn't switched.`);
      return false;
    }
    if (repo.folders.some(f => f.index === 0) && !(await this.allowFirstFolderSwap(repo, target))) return false;
    for (const { f, dest } of plan) await replaceFolder(f.index, vscode.Uri.file(dest), folderLabel(f.baseName, target));
    await this.refreshModel();
    this.rebuild();
    return true;
  }

  /**
   * VS Code restarts every extension when the workspace's first folder changes. The first time
   * that would happen, offer to pin a placeholder folder at the top so swaps never touch index 0.
   * Returns false when the swap is deferred until after the restart that adding the placeholder causes.
   */
  private async allowFirstFolderSwap(repo: Repo, target: Worktree): Promise<boolean> {
    if (!vscode.workspace.workspaceFile || vscode.workspace.workspaceFile.scheme !== "file") return true;
    if (this.ctx.workspaceState.get<string>(ANCHOR_STATE) === "never") return true;
    const ADD = "Add Placeholder Folder";
    const SKIP = "Switch Anyway";
    const NEVER = "Don't Ask Again";
    const choice = await vscode.window.showInformationMessage(
      `${repo.name} is the first folder in this workspace.`,
      {
        modal: true,
        detail: `VS Code restarts all extensions whenever the first workspace folder changes, so switching ${repo.name} makes everything reload for a moment. Your agents keep running.\n\nAdd a small empty “${ANCHOR_NAME}” folder at the top of the workspace and this won't happen again. Adding it restarts extensions once; ${repo.name} then switches to ${worktreeLabel(target)}.`,
      },
      ADD,
      SKIP,
      NEVER,
    );
    if (choice === NEVER) await this.ctx.workspaceState.update(ANCHOR_STATE, "never");
    if (choice !== ADD) return choice === SKIP || choice === NEVER;
    await this.ctx.workspaceState.update(PENDING_SWAP_STATE, { repoKey: repo.key, wtPath: target.path, at: Date.now() });
    if (!(await this.addPlaceholderFolder())) {
      await this.ctx.workspaceState.update(PENDING_SWAP_STATE, undefined);
      return true;
    }
    return false;
  }

  /** Inserts an empty folder at index 0. VS Code restarts extensions once when this happens. */
  private async addPlaceholderFolder(): Promise<boolean> {
    const first = vscode.workspace.workspaceFolders?.[0];
    if (first?.name === ANCHOR_NAME) return false;
    const dir = await ensureAnchorFolder(this.ctx.globalStorageUri);
    return vscode.workspace.updateWorkspaceFolders(0, 0, { uri: dir, name: ANCHOR_NAME });
  }

  private async switchToPrimary(repo?: Repo): Promise<void> {
    repo ??= await this.pickRepo();
    if (!repo) return;
    if (!repo.current.primary && (await this.offerWorkspace(repo, { kind: "swap", repoKey: repo.key, wtPath: repo.primary.path })) === "stop") return;
    if (await this.swap(repo, repo.primary)) vscode.window.setStatusBarMessage(`$(home) ${repo.name} is back on ${worktreeLabel(repo.primary)}`, 4000);
  }

  private async switchWorktree(repo?: Repo): Promise<void> {
    repo ??= await this.pickRepo();
    if (!repo) return;
    const wt = await this.pickWorktree(repo, { title: `Switch ${repo.name} to…`, allowCreate: false });
    if (wt && wt.path !== repo.current.path && (await this.offerWorkspace(repo, { kind: "swap", repoKey: repo.key, wtPath: wt.path })) === "stop") return;
    if (wt && (await this.swap(repo, wt))) vscode.window.setStatusBarMessage(`$(git-branch) ${repo.name} is on ${worktreeLabel(wt)}`, 4000);
  }

  // ---------- open / resume ----------

  private async openSession(v?: SessionView): Promise<void> {
    if (!v) return;
    this.selected = v.key;
    if (v.missing) {
      this.rebuild();
      return this.askMissing(v);
    }
    if (this.freshRepo(v.repo).current.path !== v.wt.path && (await this.offerWorkspace(v.repo, { kind: "open", key: v.key })) === "stop") return;
    const cwd = fs.existsSync(v.s.cwd) ? v.s.cwd : v.wt.path;
    // Start the terminal before swapping: replacing the first workspace folder restarts extensions.
    const result = await this.terminals.open({ key: v.key, name: this.terminalName(v.s.agent, v.repo, v.wt), cwd, command: this.resumeCommand(v.s), agent: v.s.agent });
    const repo = this.freshRepo(v.repo);
    const swapped = repo.current.path !== v.wt.path;
    if (swapped) await this.swap(repo, v.wt);
    vscode.window.setStatusBarMessage(`$(sparkle) ${result === "focused" ? "Focused" : "Resumed"} “${v.s.title}”${swapped ? ` · ${repo.name} → ${worktreeLabel(v.wt)}` : ""}`, 4000);
    this.rebuild();
  }

  private async askMissing(v: SessionView): Promise<void> {
    const repo = this.freshRepo(v.repo);
    const info: MissingInfo = {
      key: v.key,
      title: v.s.title,
      wtPath: tildify(v.wt.path),
      branch: v.wt.branch,
      branchExists: v.wt.branch ? await branchExists(repo.primary.path, v.wt.branch) : false,
    };
    await this.provider.post({ type: "missingDialog", info }, true);
  }

  private async recreateWorktree(v: SessionView): Promise<void> {
    const repo = this.freshRepo(v.repo);
    const branch = v.wt.branch;
    if (!branch) throw new Error("The worktree was on a detached commit and can't be recreated.");
    await pruneWorktrees(repo.primary.path);
    await addWorktree(repo.primary.path, v.wt.path, branch, { create: false });
    await this.copyIncludes(repo, v.wt.path);
    await this.refreshModel();
    await this.refreshSessions();
    await this.openSession(this.findSession(v.key));
  }

  // ---------- new session ----------

  private async pickRepo(): Promise<Repo | undefined> {
    const repos = this.model.repos;
    if (repos.length <= 1) return repos[0];
    const pick = await vscode.window.showQuickPick(
      repos.map(r => ({ label: `$(repo) ${r.name}`, description: worktreeLabel(r.current), repo: r })),
      { title: "New session in which repo?" },
    );
    return pick?.repo;
  }

  private async newSession(repoArg?: Repo): Promise<void> {
    const repo = repoArg ? this.freshRepo(repoArg) : await this.pickRepo();
    if (!repo) {
      if (!this.model.repos.length) void vscode.window.showInformationMessage("No git repositories in this workspace.");
      return;
    }
    if ((await this.offerWorkspace(repo, { kind: "new", repoKey: repo.key })) === "stop") return;
    const wt = await this.pickWorktree(repo, { title: `${repo.name}: start a session in…`, allowCreate: true });
    if (!wt) return;
    const agent = await this.pickAgent();
    if (!agent) return;
    const fresh = this.freshRepo(repo);
    const name = this.terminalName(agent, fresh, wt);
    if (agent === "claude") {
      const id = randomUUID();
      this.selected = sessionKey("claude", id);
      await this.terminals.open({ key: this.selected, name, cwd: wt.path, command: `${cfg().get<string>("claudeCommand", "claude")} --session-id ${id}`, agent });
    } else {
      this.terminals.startUnlinked({ name, cwd: wt.path, command: cfg().get<string>("codexCommand", "codex"), agent });
    }
    await this.swap(fresh, wt);
    vscode.window.setStatusBarMessage(`$(sparkle) Started ${AGENT_NAME[agent]} in ${fresh.name} ${worktreeLabel(wt)}`, 4000);
  }

  private async pickAgent(): Promise<Agent | undefined> {
    const def = cfg().get<string>("defaultAgent", "ask");
    if (def === "claude" || def === "codex") return def;
    const pick = await vscode.window.showQuickPick(
      [
        { label: "$(sparkle) Claude Code", agent: "claude" as Agent },
        { label: "$(terminal) Codex", agent: "codex" as Agent },
      ],
      { title: "Which agent?" },
    );
    return pick?.agent;
  }

  /**
   * Worktree picker. "New worktree" sits on top; only the most relevant worktrees are listed
   * until "Show all" is picked or the user types (typing searches every worktree).
   */
  private pickWorktree(repo: Repo, opts: { title: string; allowCreate: boolean }): Promise<Worktree | undefined> {
    // Creating hands off to createWorktree (it may show the base-branch picker), so this resolves with its promise.
    type Item = vscode.QuickPickItem & { wt?: Worktree; create?: string; action?: "showAll" | "hint" | "auto" };
    const stats = new Map<string, { count: number; last: number }>();
    for (const v of this.views.find(x => x.repo.key === repo.key)?.sessions ?? []) {
      const st = stats.get(v.wt.path) ?? { count: 0, last: 0 };
      st.count++;
      st.last = Math.max(st.last, v.s.mtimeMs);
      stats.set(v.wt.path, st);
    }
    // Primary first, then the open one, then by most recent session activity.
    const rank = (w: Worktree) => (w.primary ? 2 : 0) + (w.path === repo.current.path ? 1 : 0);
    const all = repo.worktrees
      .filter(w => !w.prunable && !w.bare)
      .sort((a, b) => rank(b) - rank(a) || (stats.get(b.path)?.last ?? 0) - (stats.get(a.path)?.last ?? 0));
    const toItem = (w: Worktree): Item => {
      const n = stats.get(w.path)?.count ?? 0;
      // Named by worktree folder; the branch is secondary (branches are chosen in the base-branch step).
      return {
        label: `$(${w.primary ? "home" : "folder"}) ${path.basename(w.path)}`,
        description: [
          w.branch ?? `detached ${(w.head ?? "").slice(0, 8)}`,
          w.primary ? "primary checkout" : "",
          w.path === repo.current.path ? "open now" : "",
          n ? `${n} session${n > 1 ? "s" : ""}` : "",
        ].filter(Boolean).join(" · "),
        detail: tildify(w.path),
        wt: w,
      };
    };
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = opts.title;
    qp.placeholder = opts.allowCreate ? "Pick a worktree, or type a branch name to create one" : "Pick a worktree";
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    let showAll = all.length <= PICKER_PAGE + 1;
    const render = () => {
      const v = qp.value.trim();
      const top: Item[] = [];
      if (opts.allowCreate) {
        const exact = all.some(w => w.branch === v || path.basename(w.path) === v);
        if (v && !exact) top.push({ label: `$(add) Create worktree “${v}”`, description: `then pick the branch to base it on · or use the existing branch “${v}”`, alwaysShow: true, create: v });
        else if (!v)
          top.push(
            { label: "$(sparkle) New worktree with an automatic name", description: "e.g. brisk-otter · then pick its base branch", alwaysShow: true, action: "auto" },
            { label: "$(add) New worktree…", description: "type a branch name above, then pick its base branch", alwaysShow: true, action: "hint" },
          );
      }
      // While typing, offer every worktree so the filter can find any of them.
      const list = v || showAll ? all : all.slice(0, PICKER_PAGE);
      const items: Item[] = [...top, { label: `Worktrees (${all.length})`, kind: vscode.QuickPickItemKind.Separator }, ...list.map(toItem)];
      if (!v && !showAll) items.push({ label: `$(ellipsis) Show all ${all.length} worktrees…`, description: `${all.length - PICKER_PAGE} more · or type to search`, alwaysShow: true, action: "showAll" });
      qp.items = items;
    };
    render();
    return new Promise(resolve => {
      let done = false;
      qp.onDidChangeValue(render);
      qp.onDidAccept(async () => {
        const item = qp.selectedItems[0];
        if (!item) return;
        if (item.action === "showAll") {
          showAll = true;
          render();
          return;
        }
        if (item.action === "hint") {
          qp.placeholder = "Type the new branch name, e.g. feat/my-change";
          return;
        }
        if (item.wt) {
          done = true;
          qp.hide();
          return resolve(item.wt);
        }
        let create = item.create;
        if (item.action === "auto") {
          qp.busy = true;
          create = await this.autoName(repo);
          qp.busy = false;
        }
        if (!create) return;
        qp.busy = true;
        qp.enabled = false;
        const problem = await this.checkNewBranch(repo, create);
        qp.busy = false;
        qp.enabled = true;
        if (problem) {
          void vscode.window.showErrorMessage(problem);
          return;
        }
        // Close this picker first: the base-branch picker needs the quick input.
        done = true;
        qp.hide();
        resolve(this.createWorktree(repo, create));
      });
      qp.onDidHide(() => {
        qp.dispose();
        if (!done) resolve(undefined);
      });
      qp.show();
    });
  }

  /** A fresh branch name that clashes with no branch (local or remote) and no worktree folder. */
  private async autoName(repo: Repo): Promise<string> {
    const refs = await listBranches(repo.primary.path).catch(() => []);
    const taken = new Set<string>(refs.map(r => (r.remote ? r.name.replace(/^[^/]+\//, "") : r.name)));
    const template = cfg().get<string>("worktreeRoot", "${repoParent}/${repoName}-worktrees");
    const prefix = cfg().get<string>("autoNamePrefix", "");
    for (let i = 0; i < 20; i++) {
      const name = autoBranchName(taken, prefix);
      if (!fs.existsSync(worktreePathFor(template, repo.primary.path, name))) return name;
      taken.add(name);
    }
    return autoBranchName(taken, prefix);
  }

  /** Why `branch` can't become a new worktree, or undefined if it can. */
  private async checkNewBranch(repo: Repo, branch: string): Promise<string | undefined> {
    const repoPath = repo.primary.path;
    if (!(await isValidBranchName(repoPath, branch))) return `“${branch}” isn't a valid branch name.`;
    if (repo.worktrees.some(w => w.branch === branch)) return undefined; // reused, see createWorktree
    const dir = worktreePathFor(cfg().get<string>("worktreeRoot", "${repoParent}/${repoName}-worktrees"), repoPath, branch);
    if (fs.existsSync(dir)) return `${tildify(dir)} already exists. Pick another branch name or remove that folder.`;
    return undefined;
  }

  /** Creates a worktree for `branch`. A new branch asks which branch to base it on. Undefined when cancelled. */
  private async createWorktree(repo: Repo, branch: string): Promise<Worktree | undefined> {
    const repoPath = repo.primary.path;
    const problem = await this.checkNewBranch(repo, branch);
    if (problem) throw new Error(problem);
    const inUse = repo.worktrees.find(w => w.branch === branch);
    if (inUse) {
      void vscode.window.showInformationMessage(`${branch} is already checked out in ${tildify(inUse.path)}. Git allows a branch in only one worktree, so that one is used.`);
      return inUse;
    }
    const dir = worktreePathFor(cfg().get<string>("worktreeRoot", "${repoParent}/${repoName}-worktrees"), repoPath, branch);
    const exists = await branchExists(repoPath, branch);
    let base: string | undefined;
    if (!exists) {
      base = await this.pickBaseBranch(repo, branch);
      if (!base) return undefined;
    }
    let copied: string[] = [];
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Creating worktree ⎇ ${branch}${base ? ` from ${base}` : ""}…` }, async () => {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      await addWorktree(repoPath, dir, branch, exists ? { create: false } : { create: true, base });
      copied = await this.copyIncludes(repo, dir);
    });
    await this.refreshModel();
    const real = realpath(dir);
    const wt = this.freshRepo(repo).worktrees.find(w => w.path === real);
    if (!wt) throw new Error(`Created ${tildify(dir)}, but git doesn't list it as a worktree.`);
    vscode.window.setStatusBarMessage(`$(git-branch) Created ${worktreeLabel(wt)}${base ? ` from ${base}` : ""}${copied.length ? ` · copied ${copied.join(", ")}` : ""}`, 6000);
    return wt;
  }

  /**
   * Base for a new branch. The primary checkout's branch is first (Enter keeps the old default),
   * then the open worktree's branch, then local and remote branches by recent commit, 5 each until
   * "Show all" or typing. Any typed ref (tag, sha) can be used too.
   */
  private async pickBaseBranch(repo: Repo, branch: string): Promise<string | undefined> {
    const repoPath = repo.primary.path;
    type Item = vscode.QuickPickItem & { ref?: string; action?: "showAll" | "fetch" };
    let refs = await listBranches(repoPath).catch(() => []);
    const defaultRef = repo.primary.branch ?? repo.primary.head ?? "HEAD";
    const openRef = !repo.current.primary ? repo.current.branch : undefined;
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = `New branch “${branch}”: base it on…`;
    qp.placeholder = "Pick a branch, or type a branch, tag or commit";
    let showAll = false;
    const render = () => {
      const v = qp.value.trim();
      const pinned = new Set([defaultRef, openRef].filter(Boolean) as string[]);
      const local = refs.filter(r => !r.remote && !pinned.has(r.name));
      const remote = refs.filter(r => r.remote);
      const cap = (xs: typeof refs) => (v || showAll ? xs : xs.slice(0, PICKER_PAGE));
      const whenOf = (name: string) => refs.find(r => r.name === name)?.when;
      const items: Item[] = [
        { label: `$(home) ${defaultRef}`, description: ["primary checkout's branch · default", whenOf(defaultRef)].filter(Boolean).join(" · "), ref: defaultRef },
        ...(openRef ? [{ label: `$(git-branch) ${openRef}`, description: ["open now", whenOf(openRef)].filter(Boolean).join(" · "), ref: openRef }] : []),
      ];
      if (local.length) items.push({ label: `Local branches (${local.length})`, kind: vscode.QuickPickItemKind.Separator }, ...cap(local).map(r => ({ label: `$(git-branch) ${r.name}`, description: r.when, ref: r.name })));
      if (remote.length) items.push({ label: `Remote branches (${remote.length})`, kind: vscode.QuickPickItemKind.Separator }, ...cap(remote).map(r => ({ label: `$(cloud) ${r.name}`, description: r.when, ref: r.name })));
      const hidden = Math.max(0, local.length - PICKER_PAGE) + Math.max(0, remote.length - PICKER_PAGE);
      items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
      if (v && !refs.some(r => r.name === v)) items.push({ label: `$(git-commit) Use “${v}”`, description: "branch, tag or commit", alwaysShow: true, ref: v });
      if (!v && !showAll && hidden) items.push({ label: `$(ellipsis) Show all branches…`, description: `${hidden} more · or type to search`, alwaysShow: true, action: "showAll" });
      items.push({ label: "$(sync) Fetch from remotes", description: "update the remote branch list", alwaysShow: true, action: "fetch" });
      qp.items = items;
    };
    render();
    return new Promise(resolve => {
      let done = false;
      qp.onDidChangeValue(render);
      qp.onDidAccept(async () => {
        const item = qp.selectedItems[0];
        if (!item) return;
        if (item.action === "showAll") {
          showAll = true;
          return render();
        }
        if (item.action === "fetch") {
          qp.busy = true;
          try {
            await fetchAll(repoPath);
            refs = await listBranches(repoPath).catch(() => refs);
          } catch (e) {
            void vscode.window.showErrorMessage(`Fetch failed: ${errorText(e)}`);
          }
          qp.busy = false;
          return render();
        }
        if (!item.ref) return;
        qp.busy = true;
        const ok = await refExists(repoPath, item.ref);
        qp.busy = false;
        if (!ok) {
          void vscode.window.showErrorMessage(`“${item.ref}” isn't a branch, tag or commit in ${repo.name}.`);
          return;
        }
        done = true;
        qp.hide();
        resolve(item.ref);
      });
      qp.onDidHide(() => {
        qp.dispose();
        if (!done) resolve(undefined);
      });
      qp.show();
    });
  }

  /** Brings the configured ignored files into a new worktree: files copied, folders linked. Returns a short summary list. */
  private async copyIncludes(repo: Repo, dest: string): Promise<string[]> {
    const scope = repo.folders[0]?.uri;
    const patterns = [
      ...(cfg().get<string[]>("preserve") ?? []),
      ...cfg().get<string[]>("copyFiles", []),
      ...vscode.workspace.getConfiguration("git", scope).get<string[]>("worktreeIncludeFiles", []),
    ];
    const { copied, linked } = await preserveIntoWorktree(repo.primary.path, dest, patterns);
    try {
      await excludeFromGit(dest, linked);
    } catch (e) {
      console.error("[worktree-sessions] couldn't exclude linked folders", e);
    }
    return [...copied, ...linked.map(l => `${l} (linked)`)];
  }

  // ---------- workspace setup ----------

  /** No saved .code-workspace: a single folder, or an untitled multi-root workspace. */
  private needsWorkspace(): boolean {
    const f = vscode.workspace.workspaceFile;
    return !f || f.scheme === "untitled";
  }

  /**
   * Before a switch in a window without a saved workspace, offer to create one. "stop" means the
   * caller should not continue (the window is reopening, or the user cancelled).
   */
  private async offerWorkspace(repo: Repo, action: PendingAction): Promise<"proceed" | "stop"> {
    if (!this.needsWorkspace() || this.ctx.workspaceState.get<string>(WORKSPACE_CHOICE_STATE) === "never") return "proceed";
    const CREATE = "Create Workspace…";
    const SKIP = "Continue Without";
    const NEVER = "Don't Ask Again";
    const single = !vscode.workspace.workspaceFile;
    const choice = await vscode.window.showInformationMessage(
      "Switching worktrees works best in a saved workspace.",
      {
        modal: true,
        detail: `${single ? `This window has just the ${repo.name} folder open, so switching it turns the window into an untitled workspace` : "This window's workspace isn't saved"}, and VS Code reloads every extension whenever the first folder changes.\n\nCreate a .code-workspace file with a small placeholder folder first, choose the files each new worktree should get (.env, node_modules…), and reopen this window in it. After that, switching never reloads.`,
      },
      CREATE,
      SKIP,
      NEVER,
    );
    if (choice === NEVER) await this.ctx.workspaceState.update(WORKSPACE_CHOICE_STATE, "never");
    if (choice === SKIP || choice === NEVER) return "proceed";
    if (choice === CREATE) await this.createWorkspace([], action);
    return "stop";
  }

  /**
   * Writes a .code-workspace (placeholder folder first, then the current folders plus `extra`,
   * preserved-file patterns in its settings) and reopens the window in it. `action` runs after the reopen.
   */
  private async createWorkspace(extra: vscode.Uri[], action: PendingAction): Promise<boolean> {
    const folders: { uri: vscode.Uri; name?: string }[] = (vscode.workspace.workspaceFolders ?? []).filter(f => f.name !== ANCHOR_NAME).map(f => ({ uri: f.uri, name: f.name }));
    for (const u of extra) if (!folders.some(f => f.uri.fsPath === u.fsPath)) folders.push({ uri: u });
    if (!folders.length) {
      void vscode.window.showInformationMessage("Open a project folder first, or use “Add Git Project…”.");
      return false;
    }
    const running = this.views.flatMap(v => v.sessions).filter(v => v.alive).length;
    if (running) {
      const GO = "Continue";
      const ok = await vscode.window.showWarningMessage(
        `${running} agent session${running > 1 ? "s are" : " is"} running in this window's terminals.`,
        { modal: true, detail: "Reopening the window in the new workspace closes those terminals. The conversations are saved; click a session afterwards to resume it." },
        GO,
      );
      if (ok !== GO) return false;
    }
    const inspected = cfg().inspect<string[]>("preserve");
    const current = inspected?.workspaceValue ?? inspected?.workspaceFolderValue ?? inspected?.globalValue;
    const repos = this.model.repos.map(r => ({ name: r.name, root: r.primary.path })).concat(extra.map(u => ({ name: path.basename(u.fsPath), root: u.fsPath })));
    const patterns = await this.preservePicker(this.ctx.extensionUri, { mode: "create", current, repos });
    if (!patterns) return false;
    const first = folders[0].uri.fsPath;
    const defaultName = folders.length === 1 ? path.basename(first) : path.basename(path.dirname(first));
    const target = await vscode.window.showSaveDialog({
      title: "Save the workspace file",
      defaultUri: vscode.Uri.file(path.join(path.dirname(first), `${defaultName}.code-workspace`)),
      filters: { "Code Workspace": ["code-workspace"] },
      saveLabel: "Create Workspace",
    });
    if (!target) return false;
    const anchor = await ensureAnchorFolder(this.ctx.globalStorageUri);
    const content = {
      folders: [{ name: ANCHOR_NAME, path: anchor.fsPath }, ...workspaceFolderEntries(target.fsPath, folders)],
      settings: { "worktreeSessions.preserve": patterns },
    };
    fs.writeFileSync(target.fsPath, JSON.stringify(content, null, "\t") + "\n");
    await this.ctx.globalState.update(PENDING_GLOBAL, { wsFile: target.fsPath, at: Date.now(), action });
    await vscode.commands.executeCommand("vscode.openFolder", target, { forceReuseWindow: true });
    return true;
  }

  /** Adds git repositories to the workspace. Without a saved workspace, creates one that includes them. */
  private async addProjects(): Promise<void> {
    const first = vscode.workspace.workspaceFolders?.find(f => f.name !== ANCHOR_NAME)?.uri;
    const picked = await vscode.window.showOpenDialog({
      title: "Add git projects to this workspace",
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: true,
      openLabel: "Add to Workspace",
      defaultUri: first ? vscode.Uri.file(path.dirname(first.fsPath)) : undefined,
    });
    if (!picked?.length) return;
    const add: vscode.Uri[] = [];
    const notGit: string[] = [];
    const already: string[] = [];
    for (const uri of picked) {
      const loc = await locateRepo(uri.fsPath);
      if (!loc) notGit.push(path.basename(uri.fsPath));
      else if (this.model.repos.some(r => r.key === loc.commonDir) || add.some(a => a.fsPath === uri.fsPath)) already.push(path.basename(uri.fsPath));
      else add.push(uri);
    }
    const skipped = [notGit.length ? `not git repositories: ${notGit.join(", ")}` : "", already.length ? `already in the workspace: ${already.join(", ")}` : ""].filter(Boolean).join("; ");
    if (skipped) void vscode.window.showWarningMessage(`Skipped ${skipped}.`);
    if (!add.length) return;
    if (this.needsWorkspace()) {
      await this.createWorkspace(add, { kind: "none" });
      return;
    }
    const at = vscode.workspace.workspaceFolders?.length ?? 0;
    if (!vscode.workspace.updateWorkspaceFolders(at, 0, ...add.map(uri => ({ uri })))) throw new Error("VS Code refused to add the folders.");
    vscode.window.setStatusBarMessage(`$(repo) Added ${add.map(u => path.basename(u.fsPath)).join(", ")}`, 5000);
  }

  /** Edits which ignored files and folders new worktrees get. */
  private async configurePreserve(): Promise<void> {
    const inspected = cfg().inspect<string[]>("preserve");
    const saved = !this.needsWorkspace();
    const current = saved ? (inspected?.workspaceValue ?? inspected?.globalValue) : inspected?.globalValue;
    const patterns = await this.preservePicker(this.ctx.extensionUri, { mode: "edit", current, repos: this.model.repos.map(r => ({ name: r.name, root: r.primary.path })) });
    if (!patterns) return;
    await cfg().update("preserve", patterns, saved ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
    vscode.window.setStatusBarMessage(`$(check) New worktrees will get: ${patterns.join(", ") || "nothing extra"}`, 6000);
  }


  // ---------- delete ----------

  private async askDelete(v?: SessionView): Promise<void> {
    if (!v) return;
    const info = await this.gatherDeleteInfo(v);
    await this.provider.post({ type: "deleteDialog", info }, true);
  }

  async gatherDeleteInfo(v: SessionView): Promise<DeleteInfo> {
    const repo = this.freshRepo(v.repo);
    const wt = v.wt;
    const repoPath = repo.primary.path;
    const others = this.views.flatMap(x => x.sessions).filter(x => x.key !== v.key && x.wt.path === wt.path);
    const canRemoveWt = !wt.primary && others.length === 0;
    const branch = wt.branch;
    const primaryBranch = repo.primary.branch;
    const canDeleteBranch = canRemoveWt && !!branch && branch !== primaryBranch && (await branchExists(repoPath, branch));
    const [dirty, ahead, unpushed, upstream] = await Promise.all([
      canRemoveWt && !v.missing ? dirtyCount(wt.path) : Promise.resolve(0),
      canDeleteBranch && primaryBranch ? commitsAhead(repoPath, branch!, primaryBranch) : Promise.resolve(0),
      canDeleteBranch ? unpushedCommits(repoPath, branch!) : Promise.resolve(0),
      canDeleteBranch ? upstreamOf(repoPath, branch!) : Promise.resolve(undefined),
    ]);
    const q = (p: string) => (/\s/.test(p) ? shellQuote(p) : tildify(p));
    return {
      key: v.key,
      title: v.s.title,
      agentName: AGENT_NAME[v.s.agent],
      file: v.s.files.length > 1 ? `${tildify(v.s.file)} (+${v.s.files.length - 1} earlier file${v.s.files.length > 2 ? "s" : ""} of this session)` : tildify(v.s.file),
      runningText: v.alive ? `${AGENT_NAME[v.s.agent]} is running in this session's terminal. Deleting stops it and closes the terminal.` : undefined,
      repoName: repo.name,
      wtLabel: worktreeLabel(wt),
      wtPath: tildify(wt.path),
      primary: wt.primary,
      primaryLabel: worktreeLabel(repo.primary),
      others: others.map(o => o.s.title),
      missing: v.missing,
      canRemoveWt,
      dirty,
      currentlyOpen: !wt.primary && repo.current.path === wt.path,
      canDeleteBranch,
      branch,
      primaryBranch,
      ahead,
      unpushed,
      upstream,
      cmds: {
        session: v.s.agent === "codex" ? `codex delete ${v.s.id}` : `move to Trash: ${tildify(v.s.file)}`,
        wt: v.missing ? `git -C ${q(repoPath)} worktree prune` : `git -C ${q(repoPath)} worktree remove ${dirty !== 0 ? "--force " : ""}${q(wt.path)}`,
        branch: `git -C ${q(repoPath)} branch ${ahead !== 0 || unpushed !== 0 ? "-D" : "-d"} ${branch ?? ""}`,
      },
    };
  }

  /** Runs the delete; returns an error message for the dialog, or undefined on success. */
  async performDelete(v: SessionView, rmWtAsked: boolean, rmBranchAsked: boolean): Promise<string | undefined> {
    // Re-check: the list may have changed since the dialog opened.
    const info = await this.gatherDeleteInfo(v);
    const rmWt = rmWtAsked && info.canRemoveWt;
    const rmBranch = rmBranchAsked && rmWt && info.canDeleteBranch;
    const repo = this.freshRepo(v.repo);
    const repoPath = repo.primary.path;
    const done: string[] = [];
    const failed: string[] = [];
    this.terminals.close(v.key);
    try {
      await this.deleteSessionData(v.s);
      done.push("session");
    } catch (e) {
      failed.push(`session: ${errorText(e)}`);
    }
    if (rmWt) {
      try {
        if (v.missing) await pruneWorktrees(repoPath);
        else await removeWorktree(repoPath, v.wt.path, info.dirty !== 0);
        done.push(`worktree ${worktreeLabel(v.wt)}`);
      } catch (e) {
        failed.push(`worktree: ${errorText(e)}`);
      }
    }
    if (rmBranch && info.branch && failed.length === 0) {
      try {
        await deleteBranch(repoPath, info.branch, info.ahead !== 0 || info.unpushed !== 0);
        done.push(`branch ${info.branch}`);
      } catch (e) {
        failed.push(`branch: ${errorText(e)}`);
      }
    }
    if (this.selected === v.key) this.selected = undefined;
    if (this.pinnedKeys().has(v.key)) await this.setPinned(v, false);
    // Swap last: replacing the first workspace folder restarts extensions.
    await this.refreshModel();
    if (done.some(d => d.startsWith("worktree")) && !v.missing && repo.current.path === v.wt.path) await this.swap(repo, repo.primary);
    await this.refreshSessions();
    if (failed.length) return `Deleted ${done.join(", ") || "nothing"}. Failed: ${failed.join("; ")}`;
    vscode.window.setStatusBarMessage(`$(trash) Deleted ${done.join(", ")}`, 5000);
    return undefined;
  }

  private async deleteSessionData(s: SessionInfo): Promise<void> {
    for (const f of s.files) this.scanner.forget(f);
    if (s.agent === "codex") await runCodexDelete(cfg().get<string>("codexCommand", "codex"), s.id).catch(() => undefined);
    // Whatever `codex delete` left behind (or every Claude file) goes to the Trash.
    for (const f of s.files) if (fs.existsSync(f)) await trash(f);
    // Claude keeps subagent transcripts and tool output next to the session file.
    for (const f of s.files) {
      const sidecar = f.replace(/\.jsonl$/, "");
      if (s.agent === "claude" && sidecar !== f && fs.existsSync(sidecar)) await trash(sidecar);
    }
  }

  // ---------- misc ----------

  private pinnedKeys(): Set<string> {
    return new Set(this.ctx.workspaceState.get<string[]>(PINNED_STATE, []));
  }

  private async setPinned(v: SessionView | undefined, pinned: boolean): Promise<void> {
    if (!v) return;
    const keys = this.pinnedKeys();
    if (pinned) keys.add(v.key);
    else keys.delete(v.key);
    await this.ctx.workspaceState.update(PINNED_STATE, [...keys]);
    this.rebuild();
  }

  private async hideSession(v?: SessionView): Promise<void> {
    if (!v) return;
    const hidden = new Set(this.ctx.workspaceState.get<string[]>(HIDDEN_STATE, []));
    hidden.add(v.key);
    await this.ctx.workspaceState.update(HIDDEN_STATE, [...hidden]);
    this.rebuild();
    vscode.window.setStatusBarMessage(`Hid “${v.s.title}”. Use “Show Hidden Sessions Again” to bring it back.`, 5000);
  }

  private async unhideAll(): Promise<void> {
    await this.ctx.workspaceState.update(HIDDEN_STATE, []);
    this.rebuild();
  }

  private async setFilter(f: Filter): Promise<void> {
    this.filter = f;
    await this.ctx.workspaceState.update(FILTER_STATE, f);
    this.rebuild();
  }

  private async pickFilter(): Promise<void> {
    const pick = await vscode.window.showQuickPick(
      (Object.keys(FILTER_LABELS) as Filter[]).map(f => ({ label: FILTER_LABELS[f], description: f === this.filter ? "current" : undefined, f })),
      { title: "Show sessions" },
    );
    if (pick) await this.setFilter(pick.f);
  }
}

/** Replaces one workspace folder and waits until VS Code has applied it. */
async function replaceFolder(index: number, uri: vscode.Uri, name: string): Promise<void> {
  const applied = new Promise<void>(resolve => {
    const timer = setTimeout(() => (d.dispose(), resolve()), 5000);
    const d = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      clearTimeout(timer);
      d.dispose();
      resolve();
    });
  });
  if (!vscode.workspace.updateWorkspaceFolders(index, 1, { uri, name })) throw new Error("VS Code refused to change the workspace folder.");
  await applied;
}

async function trash(file: string): Promise<void> {
  const uri = vscode.Uri.file(file);
  const recursive = fs.statSync(file).isDirectory();
  try {
    await vscode.workspace.fs.delete(uri, { useTrash: true, recursive });
  } catch {
    await vscode.workspace.fs.delete(uri, { useTrash: false, recursive });
  }
}

function runCodexDelete(codexCommand: string, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = exec(`${codexCommand} delete ${shellQuote(id)}`, { timeout: 20000 }, err => (err ? reject(err) : resolve()));
    child.stdin?.end();
  });
}

function errorText(e: unknown): string {
  if (e instanceof GitError) return `git ${e.args[0]}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}
