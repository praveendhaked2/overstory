import { constants as fsConstants, type Dirent } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

/** Never descended into unless a pattern names them (then they're linked, not walked). */
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "target", "dist", "build", ".next", ".turbo", ".cache", ".idea", ".gradle"]);

/** Converts a glob ("**\/.env", ".env.*", "config/*.local") to a RegExp over "/"-separated relative paths. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (g.endsWith("/")) g = g.slice(0, -1);
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        const slash = g[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/**
 * Like .gitignore: a bare name ("node_modules", ".env.local") matches at any depth;
 * anything with a "/" is anchored to the repo root.
 */
export function normalizePattern(p: string): string {
  if (isRegexPattern(p)) return p.trim();
  const t = p.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!t) return "";
  if (t.startsWith("/")) return t.slice(1);
  return t.includes("/") ? t : `**/${t}`;
}

/** Regex entries are stored as "re:<expression>" and matched against the path from the repo root ("apps/web/.env"). */
export function isRegexPattern(p: string): boolean {
  return p.trim().startsWith("re:");
}

/** Error text for an invalid regex entry, else undefined. */
export function regexError(p: string): string | undefined {
  try {
    new RegExp(p.trim().slice(3));
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** One matcher per valid entry; invalid regexes are dropped. */
export function compileMatchers(patterns: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const raw of new Set(patterns.map(normalizePattern).filter(Boolean))) {
    if (isRegexPattern(raw)) {
      if (!regexError(raw)) out.push(new RegExp(raw.slice(3)));
    } else out.push(globToRegExp(raw));
  }
  return out;
}

export interface MatchItem {
  rel: string;
  /** Files are copied, folders are linked. */
  action: "copy" | "link";
}

/** Walks `root` and reports what `patterns` would bring into a new worktree, without touching anything. */
export async function scanMatches(root: string, patterns: string[], limit = 200): Promise<{ items: MatchItem[]; truncated: boolean }> {
  const res = compileMatchers(patterns);
  const items: MatchItem[] = [];
  let truncated = false;
  if (!res.length) return { items, truncated };
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > 10) return;
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (items.length >= limit) {
        truncated = true;
        return;
      }
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      const matched = res.some(x => x.test(r));
      if (ent.isDirectory()) {
        if (matched) items.push({ rel: r, action: "link" });
        else if (!SKIP_DIRS.has(ent.name)) await walk(r, depth + 1);
      } else if (ent.isFile() && matched) items.push({ rel: r, action: "copy" });
    }
  };
  await walk("", 0);
  return { items, truncated };
}

export interface PreserveResult {
  /** Files copied (relative paths). */
  copied: string[];
  /** Folders linked back to the primary checkout's copy (relative paths). */
  linked: string[];
}

/**
 * Brings ignored local files from `from` (primary checkout) into the new worktree `to`.
 * Matching files are copied; matching folders (node_modules, .venv…) are symlinked to the
 * original so nothing large is duplicated. Existing paths in `to` are never overwritten.
 */
export async function preserveIntoWorktree(from: string, to: string, patterns: string[], limit = 500): Promise<PreserveResult> {
  const res = compileMatchers(patterns);
  const out: PreserveResult = { copied: [], linked: [] };
  if (!res.length) return out;
  const exists = async (p: string) => {
    try {
      await fsp.lstat(p);
      return true;
    } catch {
      return false;
    }
  };
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > 10 || out.copied.length + out.linked.length >= limit) return;
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(path.join(from, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      const matched = res.some(x => x.test(r));
      const dest = path.join(to, r);
      if (ent.isDirectory()) {
        if (matched) {
          if (await exists(dest)) continue;
          try {
            await fsp.mkdir(path.dirname(dest), { recursive: true });
            await fsp.symlink(path.join(from, r), dest, process.platform === "win32" ? "junction" : "dir");
            out.linked.push(r);
          } catch {
            // Can't link here; leave it.
          }
        } else if (!SKIP_DIRS.has(ent.name)) {
          await walk(r, depth + 1);
        }
      } else if (ent.isFile() && matched) {
        try {
          await fsp.mkdir(path.dirname(dest), { recursive: true });
          await fsp.copyFile(path.join(from, r), dest, fsConstants.COPYFILE_EXCL);
          out.copied.push(r);
        } catch {
          // Already present in the new worktree (e.g. tracked), or unreadable: leave it.
        }
      }
    }
  };
  await walk("", 0);
  return out;
}
