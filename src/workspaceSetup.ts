import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

export const ANCHOR_NAME = "· workspace";

export interface Preset {
  label: string;
  patterns: string[];
  detail: string;
  /** Paths (relative to a repo root) whose presence marks the preset as found. */
  probe: string[];
  /** Ticked by default when found. */
  defaultWhenFound: boolean;
}

export const PRESETS: Preset[] = [
  { label: ".env files", patterns: [".env", ".env.*"], detail: ".env, .env.local and friends, in any folder", probe: [".env", ".env.local"], defaultWhenFound: true },
  { label: "node_modules", patterns: ["node_modules"], detail: "No reinstall per worktree; installs are shared", probe: ["node_modules"], defaultWhenFound: false },
  { label: "Python virtualenv (.venv, venv)", patterns: [".venv", "venv"], detail: "A copied virtualenv breaks, so it's linked", probe: [".venv", "venv"], defaultWhenFound: true },
  { label: "Claude Code local settings", patterns: ["/.claude/settings.local.json"], detail: "Your local permissions and settings for Claude Code", probe: [".claude/settings.local.json"], defaultWhenFound: true },
  { label: "direnv (.envrc)", patterns: [".envrc"], detail: "Per-folder environment for direnv", probe: [".envrc"], defaultWhenFound: true },
];

/** Folder entries for a .code-workspace file: paths relative to the file when inside its folder. */
export function workspaceFolderEntries(wsFile: string, folders: { uri: vscode.Uri; name?: string }[]): { path: string; name?: string }[] {
  const base = path.dirname(wsFile);
  return folders.map(f => {
    const rel = path.relative(base, f.uri.fsPath);
    const p = !rel.startsWith("..") && !path.isAbsolute(rel) ? rel || "." : f.uri.fsPath;
    return f.name && f.name !== path.basename(f.uri.fsPath) ? { path: p, name: f.name } : { path: p };
  });
}

/** Creates (if needed) the empty folder kept first in workspaces so switching never touches folder 0. */
export async function ensureAnchorFolder(globalStorage: vscode.Uri): Promise<vscode.Uri> {
  const dir = vscode.Uri.joinPath(globalStorage, "workspace-anchor");
  await vscode.workspace.fs.createDirectory(dir);
  await vscode.workspace.fs.writeFile(
    vscode.Uri.joinPath(dir, "README.md"),
    Buffer.from("Placeholder first folder added by Overstory.\n\nVS Code restarts extensions when a workspace's first folder changes; keeping this folder first means switching worktrees never does that. It's safe to remove from the workspace.\n"),
  );
  return dir;
}
