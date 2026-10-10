import type { Activity } from "./core/activity.ts";
import type { Worktree } from "./core/git.ts";
import type { Agent, SessionInfo } from "./core/sessions.ts";
import type { Repo } from "./model.ts";

export type Filter = "all" | "active" | "claude" | "codex";

export interface SessionView {
  s: SessionInfo;
  key: string;
  repo: Repo;
  wt: Worktree;
  /** A terminal of ours is linked to the session. */
  attached: boolean;
  /** The agent process is running in that terminal. */
  alive: boolean;
  /** Running, waiting for input, or idle. */
  activity: Activity;
  /** The worktree folder no longer exists. */
  missing: boolean;
}

export interface RepoView {
  repo: Repo;
  sessions: SessionView[];
}

// ---------- messages to the webview ----------

/** The session's icon: running · waiting for input · not running or turn finished · worktree folder gone */
export type DotState = Activity | "missing";

export interface UiSession {
  key: string;
  title: string;
  agent: Agent;
  wtLabel: string;
  wtPrimary: boolean;
  turns: number;
  ago: string;
  state: DotState;
  /** The repo currently shows a different worktree, so clicking swaps it. */
  inactive: boolean;
  /** Pinned sessions stay at the top of their repo, outside the 5-session page. */
  pinned: boolean;
  tooltip: string;
}

export interface UiRepo {
  key: string;
  name: string;
  currentLabel: string;
  currentPrimary: boolean;
  primaryLabel: string;
  total: number;
  running: number;
  waiting: number;
  sessions: UiSession[];
}

export interface UiState {
  repos: UiRepo[];
  filter: Filter;
  maxAgeDays: number;
  selected?: string;
  banner?: string;
  /** No saved .code-workspace: show the "Create workspace" banner. */
  noWorkspace?: boolean;
}

export interface DeleteInfo {
  key: string;
  title: string;
  agentName: string;
  file: string;
  runningText?: string;
  repoName: string;
  wtLabel: string;
  wtPath: string;
  primary: boolean;
  primaryLabel: string;
  others: string[];
  missing: boolean;
  canRemoveWt: boolean;
  dirty: number;
  currentlyOpen: boolean;
  canDeleteBranch: boolean;
  branch?: string;
  primaryBranch?: string;
  ahead: number;
  unpushed: number;
  upstream?: string;
  cmds: { session: string; wt: string; branch: string };
}

export interface MissingInfo {
  key: string;
  title: string;
  wtPath: string;
  branch?: string;
  branchExists: boolean;
}

export type ToWebview =
  | { type: "state"; state: UiState }
  | { type: "deleteDialog"; info: DeleteInfo }
  | { type: "missingDialog"; info: MissingInfo }
  | { type: "dialogDone"; error?: string }
  | { type: "collapseAll" };

export type FromWebview =
  | { type: "ready" }
  | { type: "open"; key: string }
  | { type: "delete"; key: string }
  | { type: "confirmDelete"; key: string; rmWt: boolean; rmBranch: boolean }
  | { type: "missingAction"; key: string; action: "recreate" | "hide" }
  | { type: "new"; repoKey?: string }
  | { type: "home"; repoKey: string }
  | { type: "filter"; filter: Filter }
  | { type: "pin"; key: string; pinned: boolean }
  | { type: "dismissBanner" }
  | { type: "createWorkspace" }
  | { type: "addProject" }
  | { type: "configurePreserve" }
  | { type: "dismissWorkspaceBanner" };
