import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { listWorktrees, locateRepo, realpath, type Worktree } from "./core/git.ts";
import { isInside } from "./core/paths.ts";

export interface RepoFolder {
  index: number;
  uri: vscode.Uri;
  /** Path of the workspace folder relative to its worktree root ("" for the root itself). */
  subpath: string;
  /** Folder name without our "⎇ branch" suffix. */
  baseName: string;
}

export interface Repo {
  /** Shared .git dir: the same for every worktree of the repo. */
  key: string;
  name: string;
  primary: Worktree;
  worktrees: Worktree[];
  /** Worktree the workspace currently shows for this repo. */
  current: Worktree;
  folders: RepoFolder[];
}

export const SUFFIX_RE = / [⎇⌂] .*$/;

export function folderLabel(baseName: string, wt: Worktree): string {
  return wt.primary ? baseName : `${baseName} ⎇ ${wt.branch ?? (wt.head ?? "detached").slice(0, 8)}`;
}

export function worktreeLabel(wt: Worktree): string {
  const name = wt.branch ?? `detached ${(wt.head ?? "").slice(0, 8)}`;
  return wt.primary ? `⌂ ${name}` : `⎇ ${name}`;
}

/** The repos behind the workspace folders, with their worktrees. */
export class WorkspaceModel {
  repos: Repo[] = [];

  async refresh(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const located = await Promise.all(folders.map(async f => ({ f, loc: f.uri.scheme === "file" ? await locateRepo(f.uri.fsPath) : undefined })));
    const byKey = new Map<string, { loc: NonNullable<(typeof located)[number]["loc"]>; f: vscode.WorkspaceFolder }[]>();
    for (const { f, loc } of located) {
      if (!loc) continue;
      const list = byKey.get(loc.commonDir) ?? [];
      list.push({ f, loc });
      byKey.set(loc.commonDir, list);
    }
    const repos: Repo[] = [];
    for (const [key, entries] of byKey) {
      let worktrees: Worktree[];
      try {
        worktrees = await listWorktrees(entries[0].loc.toplevel);
      } catch {
        continue;
      }
      const primary = worktrees.find(w => w.primary && !w.bare) ?? worktrees[0];
      if (!primary) continue;
      const name = path.basename(primary.path);
      const repoFolders: RepoFolder[] = entries.map(({ f, loc }) => {
        const subpath = path.relative(loc.toplevel, realpath(f.uri.fsPath));
        const defaultName = path.basename(f.uri.fsPath);
        const stripped = f.name.replace(SUFFIX_RE, "");
        const baseName = stripped && stripped !== defaultName ? stripped : subpath ? path.basename(subpath) : name;
        return { index: f.index, uri: f.uri, subpath, baseName };
      });
      const firstTop = entries[0].loc.toplevel;
      const current = worktrees.find(w => w.path === firstTop) ?? primary;
      repos.push({ key, name, primary, worktrees, current, folders: repoFolders });
    }
    repos.sort((a, b) => Math.min(...a.folders.map(f => f.index)) - Math.min(...b.folders.map(f => f.index)));
    this.repos = repos;
  }

  allWorktreePaths(): string[] {
    return this.repos.flatMap(r => r.worktrees.map(w => w.path));
  }

  /** Repo and worktree a session folder belongs to (the deepest worktree containing it). */
  locate(cwd: string): { repo: Repo; worktree: Worktree } | undefined {
    const p = fs.existsSync(cwd) ? realpath(cwd) : path.resolve(cwd);
    let best: { repo: Repo; worktree: Worktree } | undefined;
    for (const repo of this.repos) {
      for (const wt of repo.worktrees) {
        if (isInside(p, wt.path) && (!best || wt.path.length > best.worktree.path.length)) best = { repo, worktree: wt };
      }
    }
    return best;
  }
}
