import * as os from "node:os";
import * as path from "node:path";

/** Claude Code stores a project's sessions in ~/.claude/projects/<cwd with every non-alphanumeric char as "-">. */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Folder-safe name for a branch: "feat/ocr-scope" -> "feat-ocr-scope". */
export function branchSlug(branch: string): string {
  return branch.replace(/[\\/]+/g, "-").replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "") || "worktree";
}

/** True when `child` is `parent` or somewhere below it. */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function expandWorktreeRoot(template: string, primaryPath: string): string {
  const vars: Record<string, string> = {
    repoParent: path.dirname(primaryPath),
    repoName: path.basename(primaryPath),
    repoPath: primaryPath,
    home: os.homedir(),
  };
  const out = template.replace(/\$\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
  return path.resolve(out.startsWith("~") ? path.join(os.homedir(), out.slice(1)) : out);
}

export function worktreePathFor(template: string, primaryPath: string, branch: string): string {
  return path.join(expandWorktreeRoot(template, primaryPath), branchSlug(branch));
}

/** Quote for POSIX shells (bash/zsh/fish all accept single quotes). */
export function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9_./:@%+=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function tildify(p: string): string {
  const home = os.homedir();
  return isInside(p, home) ? "~" + p.slice(home.length) : p;
}

export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d`;
  return `${Math.round(d / 30)}mo`;
}
