import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface Worktree {
  path: string;
  head?: string;
  /** Short branch name, e.g. "feat/x". Undefined when detached. */
  branch?: string;
  detached: boolean;
  bare: boolean;
  /** Git still has a record but the folder is gone. */
  prunable: boolean;
  locked: boolean;
  /** The repo's original checkout (first entry in `git worktree list`). */
  primary: boolean;
}

export class GitError extends Error {
  readonly stderr: string;
  readonly args: string[];
  constructor(message: string, stderr: string, args: string[]) {
    super(message);
    this.stderr = stderr;
    this.args = args;
  }
}

export function git(args: string[], cwd: string, timeoutMs = 20000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message).trim().split("\n").filter(Boolean).pop() ?? err.message;
        reject(new GitError(msg, String(stderr), args));
      } else {
        resolve(String(stdout));
      }
    });
  });
}

export function realpath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

export function parseWorktreePorcelain(out: string): Worktree[] {
  const result: Worktree[] = [];
  for (const block of out.split(/\n\s*\n/)) {
    const lines = block.split("\n").map(l => l.trimEnd()).filter(Boolean);
    const first = lines.find(l => l.startsWith("worktree "));
    if (!first) continue;
    const wt: Worktree = { path: first.slice("worktree ".length), detached: false, bare: false, prunable: false, locked: false, primary: result.length === 0 };
    for (const l of lines) {
      if (l.startsWith("HEAD ")) wt.head = l.slice(5);
      else if (l.startsWith("branch ")) wt.branch = l.slice(7).replace(/^refs\/heads\//, "");
      else if (l === "detached") wt.detached = true;
      else if (l === "bare") wt.bare = true;
      else if (l === "prunable" || l.startsWith("prunable ")) wt.prunable = true;
      else if (l === "locked" || l.startsWith("locked ")) wt.locked = true;
    }
    result.push(wt);
  }
  return result;
}

export interface RepoLocation {
  /** Root of the worktree that contains the folder. */
  toplevel: string;
  /** Shared .git directory; identical for every worktree of one repo. */
  commonDir: string;
}

export async function locateRepo(folder: string): Promise<RepoLocation | undefined> {
  try {
    const out = await git(["rev-parse", "--show-toplevel", "--git-common-dir"], folder);
    const [top, common] = out.trim().split("\n");
    if (!top || !common) return undefined;
    return { toplevel: realpath(top), commonDir: realpath(path.resolve(folder, common)) };
  } catch {
    return undefined;
  }
}

export async function listWorktrees(repoPath: string): Promise<Worktree[]> {
  const out = await git(["worktree", "list", "--porcelain"], repoPath);
  return parseWorktreePorcelain(out).map(w => ({ ...w, path: w.prunable ? path.resolve(w.path) : realpath(w.path) }));
}

/** Number of changed + untracked files; -1 when it can't be read. */
export async function dirtyCount(worktreePath: string): Promise<number> {
  try {
    const out = await git(["status", "--porcelain", "--untracked-files=normal"], worktreePath);
    return out.split("\n").filter(Boolean).length;
  } catch {
    return -1;
  }
}

async function count(args: string[], cwd: string): Promise<number> {
  try {
    return parseInt((await git(args, cwd)).trim(), 10) || 0;
  } catch {
    return -1;
  }
}

/** Commits on `branch` that `base` doesn't have. */
export function commitsAhead(repoPath: string, branch: string, base: string): Promise<number> {
  return count(["rev-list", "--count", `refs/heads/${base}..refs/heads/${branch}`], repoPath);
}

/** Commits only `branch` has: on no remote-tracking ref and no other local branch. Deleting the branch loses them. */
export function unpushedCommits(repoPath: string, branch: string): Promise<number> {
  return count(["rev-list", "--count", `refs/heads/${branch}`, "--not", "--remotes", `--exclude=${branch}`, "--branches"], repoPath);
}

export async function upstreamOf(repoPath: string, branch: string): Promise<string | undefined> {
  try {
    return (await git(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`], repoPath)).trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoPath);
    return true;
  } catch {
    return false;
  }
}

export async function isValidBranchName(repoPath: string, name: string): Promise<boolean> {
  try {
    await git(["check-ref-format", "--branch", name], repoPath);
    return true;
  } catch {
    return false;
  }
}

export async function addWorktree(repoPath: string, dir: string, branch: string, opts: { create: boolean; base?: string }): Promise<void> {
  // --no-track: a new branch based on origin/x shouldn't push to origin/x.
  const args = opts.create ? ["worktree", "add", "--no-track", "-b", branch, dir, ...(opts.base ? [opts.base] : [])] : ["worktree", "add", dir, branch];
  await git(args, repoPath, 120000);
}

export async function removeWorktree(repoPath: string, dir: string, force: boolean): Promise<void> {
  await git(["worktree", "remove", ...(force ? ["--force", "--force"] : []), dir], repoPath, 120000);
}

export async function pruneWorktrees(repoPath: string): Promise<void> {
  await git(["worktree", "prune"], repoPath);
}

export async function deleteBranch(repoPath: string, branch: string, force: boolean): Promise<void> {
  await git(["branch", force ? "-D" : "-d", branch], repoPath);
}

export interface BranchRef {
  /** Short name: "feat/x" or "origin/feat/x". */
  name: string;
  remote: boolean;
  /** e.g. "3 days ago" */
  when: string;
}

/** Local and remote-tracking branches, most recently committed first. */
export async function listBranches(repoPath: string): Promise<BranchRef[]> {
  const out = await git(["for-each-ref", "--sort=-committerdate", "--format=%(refname)%09%(refname:short)%09%(committerdate:relative)", "refs/heads", "refs/remotes"], repoPath);
  const refs: BranchRef[] = [];
  for (const line of out.split("\n")) {
    const [full, name, when] = line.split("\t");
    if (!full || !name || full.endsWith("/HEAD")) continue;
    refs.push({ name, remote: full.startsWith("refs/remotes/"), when: when ?? "" });
  }
  return refs;
}

/** True when `ref` names a commit (branch, tag, sha…). */
export async function refExists(repoPath: string, ref: string): Promise<boolean> {
  try {
    await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repoPath);
    return true;
  } catch {
    return false;
  }
}

export async function fetchAll(repoPath: string): Promise<void> {
  await git(["fetch", "--all", "--prune"], repoPath, 120000);
}

/**
 * Adds anchored entries ("/node_modules") to the repo's shared info/exclude, so symlinks we create
 * in worktrees never show up as untracked files (a "node_modules/" gitignore rule doesn't match a symlink).
 */
export async function excludeFromGit(worktreePath: string, relPaths: string[]): Promise<void> {
  if (!relPaths.length) return;
  const common = path.resolve(worktreePath, (await git(["rev-parse", "--git-common-dir"], worktreePath)).trim());
  const file = path.join(common, "info", "exclude");
  let current = "";
  try {
    current = fs.readFileSync(file, "utf8");
  } catch {}
  const have = new Set(current.split("\n").map(l => l.trim()));
  const add = relPaths.map(r => `/${r}`).filter(l => !have.has(l));
  if (!add.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(file, `${prefix}# linked into worktrees by Overstory\n${add.join("\n")}\n`);
}
