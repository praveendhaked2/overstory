import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { encodeClaudeProjectDir } from "./paths.ts";

export type Agent = "claude" | "codex";

export interface SessionInfo {
  agent: Agent;
  id: string;
  /** The newest file of the session. */
  file: string;
  /** Every file belonging to the session (Codex writes a new file each time a session is resumed). */
  files: string[];
  /** Folder the agent was started in. Resume must run from here. */
  cwd: string;
  title: string;
  /** Prompts the user typed. */
  turns: number;
  mtimeMs: number;
  createdMs: number;
  /** The agent is inside a turn: the user sent a prompt and the turn hasn't finished or been interrupted. */
  turnOpen: boolean;
  /** Tools the agent called whose results haven't come back yet. */
  pendingTools: string[];
}

export interface Parsed {
  id?: string;
  cwd?: string;
  customTitle?: string;
  aiTitle?: string;
  summary?: string;
  firstPrompt?: string;
  turns: number;
  /** Codex: prompts seen as response items (newer CLIs) vs. user_message events (older); the larger wins. */
  codexItemTurns?: number;
  createdMs?: number;
  turnOpen?: boolean;
  /** tool call id -> tool name */
  pending?: Record<string, string>;
}

function endTurn(p: Parsed): void {
  p.turnOpen = false;
  p.pending = {};
}

interface CacheEntry {
  size: number;
  mtimeMs: number;
  offset: number;
  partial: string;
  parsed: Parsed;
}

const CHUNK = 1024 * 1024;

export function cleanTitle(s: string | undefined, max = 80): string | undefined {
  if (!s) return undefined;
  const t = s.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

/** Text the user typed in a Claude `user` line, or undefined for tool results, meta lines and slash-command plumbing. */
export function claudeUserText(o: any): string | undefined {
  if (o.isMeta || o.isSidechain || o.isCompactSummary) return undefined;
  const c = o.message?.content;
  let text: string | undefined;
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) {
    if (c.some((p: any) => p?.type === "tool_result")) return undefined;
    text = c.filter((p: any) => p?.type === "text" && typeof p.text === "string").map((p: any) => p.text).join("\n");
  }
  if (!text) return undefined;
  const t = text.trim();
  if (!t || /^<(command-|local-command|system-reminder|bash-|user-memory-input)/.test(t) || t.startsWith("Caveat: ") || t.startsWith("[Request interrupted")) return undefined;
  return t;
}

/** Text the user typed in a Codex user_message event, skipping injected AGENTS.md / environment context. */
export function codexUserText(payload: any): string | undefined {
  const m = payload?.message;
  if (typeof m !== "string") return undefined;
  const t = m.trim();
  if (!t || t.startsWith("<") || t.startsWith("# AGENTS.md")) return undefined;
  return t;
}

export function applyClaudeLine(p: Parsed, line: string): void {
  // Cheap pre-filter: most lines are attachments and tool output.
  const interesting =
    line.includes('"type":"user"') ||
    line.includes('"type":"assistant"') ||
    line.includes('"turn_duration"') ||
    line.includes("-title\"") ||
    line.includes('"type":"summary"') ||
    (!p.cwd && line.includes('"cwd"'));
  if (!interesting) return;
  let o: any;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  if (!p.cwd && typeof o.cwd === "string") p.cwd = o.cwd;
  if (!p.id && typeof o.sessionId === "string") p.id = o.sessionId;
  if (!p.createdMs && typeof o.timestamp === "string") p.createdMs = Date.parse(o.timestamp) || undefined;
  switch (o.type) {
    case "custom-title":
      if (typeof o.customTitle === "string") p.customTitle = o.customTitle;
      break;
    case "ai-title":
      if (typeof o.aiTitle === "string") p.aiTitle = o.aiTitle;
      break;
    case "summary":
      if (typeof o.summary === "string") p.summary = o.summary;
      break;
    case "system":
      // Written when a turn finishes.
      if (o.subtype === "turn_duration") endTurn(p);
      break;
    case "user": {
      if (o.isSidechain) break;
      const content = o.message?.content;
      if (Array.isArray(content)) {
        for (const b of content) if (b?.type === "tool_result" && typeof b.tool_use_id === "string" && p.pending) delete p.pending[b.tool_use_id];
      }
      const raw = typeof content === "string" ? content : Array.isArray(content) ? content.map((b: any) => (b?.type === "text" ? b.text : "")).join("") : "";
      if (typeof raw === "string" && raw.includes("[Request interrupted by user")) {
        endTurn(p);
        break;
      }
      const t = claudeUserText(o);
      if (t) {
        p.turns++;
        p.firstPrompt ??= t;
        p.pending = {};
      }
      if (t || (Array.isArray(content) && content.some((b: any) => b?.type === "tool_result"))) p.turnOpen = true;
      break;
    }
    case "assistant": {
      if (o.isSidechain) break;
      const content = o.message?.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === "tool_use" && typeof b.id === "string") (p.pending ??= {})[b.id] = String(b.name ?? "");
        }
      }
      p.turnOpen = true;
      break;
    }
  }
}

export function applyCodexLine(p: Parsed, line: string): void {
  if (
    !line.includes('"session_meta"') &&
    !line.includes('"user_message"') &&
    !line.includes('"role":"user"') &&
    !line.includes('"task_') &&
    !line.includes('"turn_aborted"') &&
    !line.includes('_call')
  )
    return;
  let o: any;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  const pl = o.payload ?? {};
  if (o.type === "session_meta") {
    if (typeof pl.id === "string") p.id ??= pl.id;
    if (typeof pl.cwd === "string") p.cwd ??= pl.cwd;
    const ts = Date.parse(pl.timestamp ?? o.timestamp ?? "");
    if (ts) p.createdMs ??= ts;
  } else if (o.type === "event_msg" && pl.type === "task_started") {
    p.turnOpen = true;
    p.pending = {};
  } else if (o.type === "event_msg" && (pl.type === "task_complete" || pl.type === "turn_aborted")) {
    endTurn(p);
  } else if (o.type === "response_item" && (pl.type === "function_call" || pl.type === "custom_tool_call" || pl.type === "local_shell_call")) {
    if (typeof pl.call_id === "string") (p.pending ??= {})[pl.call_id] = String(pl.name ?? pl.type);
  } else if (o.type === "response_item" && typeof pl.type === "string" && pl.type.endsWith("_call_output")) {
    if (typeof pl.call_id === "string" && p.pending) delete p.pending[pl.call_id];
  } else if (o.type === "event_msg" && pl.type === "user_message") {
    const t = codexUserText(pl);
    if (t) {
      p.turns++;
      p.firstPrompt ??= t;
    }
  } else if (o.type === "response_item" && pl.type === "message" && pl.role === "user" && Array.isArray(pl.content)) {
    const text = pl.content.filter((c: any) => c?.type === "input_text" && typeof c.text === "string").map((c: any) => c.text).join("\n");
    const t = codexUserText({ message: text });
    if (t) {
      p.codexItemTurns = (p.codexItemTurns ?? 0) + 1;
      p.firstPrompt ??= t;
    }
  }
}

export interface ScannerOptions {
  claudeHome: string;
  codexHome: string;
  maxAgeDays: number;
}

/**
 * Reads Claude Code and Codex session files. Files are parsed incrementally:
 * only bytes appended since the last scan are read.
 */
export class SessionScanner {
  private cache = new Map<string, CacheEntry>();
  private codexNames = new Map<string, string>();
  private codexIndexMtime = 0;
  opts: ScannerOptions;

  constructor(opts: ScannerOptions) {
    this.opts = opts;
  }

  /** Sessions whose project folder could belong to one of `roots`. Callers still match on `cwd`. */
  async scan(roots: string[]): Promise<SessionInfo[]> {
    const cutoff = Date.now() - this.opts.maxAgeDays * 86400000;
    const seen = new Set<string>();
    const out: SessionInfo[] = [];
    const [claude, codex] = await Promise.all([this.claudeFiles(roots, cutoff), this.codexFiles(cutoff)]);
    await this.loadCodexIndex();
    for (const [agent, files] of [["claude", claude], ["codex", codex]] as const) {
      await Promise.all(files.map(async f => {
        seen.add(f.file);
        const parsed = await this.parse(f.file, f.size, f.mtimeMs, agent === "claude" ? applyClaudeLine : applyCodexLine);
        if (!parsed?.cwd) return;
        const id = parsed.id ?? (agent === "claude" ? path.basename(f.file, ".jsonl") : codexIdFromName(f.file));
        if (!id) return;
        const title = agent === "claude"
          ? cleanTitle(parsed.customTitle) ?? cleanTitle(parsed.aiTitle) ?? cleanTitle(parsed.summary) ?? cleanTitle(parsed.firstPrompt)
          : cleanTitle(this.codexNames.get(id)) ?? cleanTitle(parsed.firstPrompt);
        out.push({ agent, id, file: f.file, files: [f.file], cwd: parsed.cwd, title: title ?? "Untitled session", turns: Math.max(parsed.turns, parsed.codexItemTurns ?? 0), turnOpen: !!parsed.turnOpen, pendingTools: Object.values(parsed.pending ?? {}), mtimeMs: f.mtimeMs, createdMs: parsed.createdMs ?? f.mtimeMs });
      }));
    }
    for (const k of this.cache.keys()) if (!seen.has(k)) this.cache.delete(k);
    return mergeSessionFiles(out);
  }

  forget(file: string): void {
    this.cache.delete(file);
  }

  private async claudeFiles(roots: string[], cutoff: number) {
    const base = path.join(this.opts.claudeHome, "projects");
    const prefixes = roots.map(encodeClaudeProjectDir);
    let dirs: string[] = [];
    try {
      dirs = await fsp.readdir(base);
    } catch {
      return [];
    }
    const wanted = dirs.filter(d => prefixes.some(p => d.startsWith(p)));
    const files: { file: string; size: number; mtimeMs: number }[] = [];
    await Promise.all(wanted.map(async d => {
      const dir = path.join(base, d);
      let names: string[] = [];
      try {
        names = await fsp.readdir(dir);
      } catch {
        return;
      }
      await Promise.all(names.filter(n => n.endsWith(".jsonl")).map(async n => {
        const file = path.join(dir, n);
        try {
          const st = await fsp.stat(file);
          if (st.isFile() && st.mtimeMs >= cutoff && st.size > 0) files.push({ file, size: st.size, mtimeMs: st.mtimeMs });
        } catch {}
      }));
    }));
    return files;
  }

  private async codexFiles(cutoff: number) {
    const base = path.join(this.opts.codexHome, "sessions");
    const files: { file: string; size: number; mtimeMs: number }[] = [];
    // Layout: sessions/YYYY/MM/DD/rollout-*.jsonl. A session started before the cutoff
    // can still be active, so date folders are only a hint; mtime decides.
    const cutoffDay = new Date(cutoff - 86400000 * 3);
    const dayKey = (y: number, m: number, d: number) => y * 10000 + m * 100 + d;
    const minKey = dayKey(cutoffDay.getFullYear(), cutoffDay.getMonth() + 1, cutoffDay.getDate());
    const ls = async (p: string) => {
      try {
        return await fsp.readdir(p);
      } catch {
        return [] as string[];
      }
    };
    for (const y of await ls(base)) {
      if (!/^\d{4}$/.test(y) || +y < cutoffDay.getFullYear()) continue;
      for (const m of await ls(path.join(base, y))) {
        if (!/^\d{2}$/.test(m) || dayKey(+y, +m, 31) < minKey) continue;
        for (const d of await ls(path.join(base, y, m))) {
          if (!/^\d{2}$/.test(d) || dayKey(+y, +m, +d) < minKey) continue;
          const dir = path.join(base, y, m, d);
          await Promise.all((await ls(dir)).filter(n => n.startsWith("rollout-") && n.endsWith(".jsonl")).map(async n => {
            const file = path.join(dir, n);
            try {
              const st = await fsp.stat(file);
              if (st.isFile() && st.mtimeMs >= cutoff && st.size > 0) files.push({ file, size: st.size, mtimeMs: st.mtimeMs });
            } catch {}
          }));
        }
      }
    }
    return files;
  }

  private async loadCodexIndex(): Promise<void> {
    const file = path.join(this.opts.codexHome, "session_index.jsonl");
    let st: fs.Stats;
    try {
      st = await fsp.stat(file);
    } catch {
      return;
    }
    if (st.mtimeMs === this.codexIndexMtime) return;
    this.codexIndexMtime = st.mtimeMs;
    const names = new Map<string, string>();
    for (const line of (await fsp.readFile(file, "utf8")).split("\n")) {
      try {
        const o = JSON.parse(line);
        if (typeof o.id === "string" && typeof o.thread_name === "string") names.set(o.id, o.thread_name);
      } catch {}
    }
    this.codexNames = names;
  }

  private async parse(file: string, size: number, mtimeMs: number, apply: (p: Parsed, line: string) => void): Promise<Parsed | undefined> {
    let e = this.cache.get(file);
    if (e && e.size === size && e.mtimeMs === mtimeMs) return e.parsed;
    if (!e || size < e.offset) {
      e = { size: 0, mtimeMs: 0, offset: 0, partial: "", parsed: { turns: 0 } };
      this.cache.set(file, e);
    }
    let fh: fsp.FileHandle | undefined;
    try {
      fh = await fsp.open(file, "r");
      const buf = Buffer.alloc(CHUNK);
      while (e.offset < size) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, size - e.offset), e.offset);
        if (bytesRead <= 0) break;
        e.offset += bytesRead;
        const text = e.partial + buf.toString("utf8", 0, bytesRead);
        const lines = text.split("\n");
        e.partial = lines.pop() ?? "";
        for (const l of lines) if (l) apply(e.parsed, l);
      }
      // JSONL writers end every record with "\n"; an unterminated tail is a line still being written.
      e.size = size;
      e.mtimeMs = mtimeMs;
      return e.parsed;
    } catch {
      return e.parsed;
    } finally {
      await fh?.close();
    }
  }
}

export function codexIdFromName(file: string): string | undefined {
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(file);
  return m?.[1];
}

/**
 * One entry per session. Codex continues a resumed session in a new file
 * (rollout-…-<id>_<part>.jsonl) with the same id: the newest file supplies the state and title,
 * the prompt count is the largest seen (later files can replay history), and every file is kept for deletion.
 */
export function mergeSessionFiles(sessions: SessionInfo[]): SessionInfo[] {
  const byKey = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    const k = `${s.agent}:${s.id}`;
    const list = byKey.get(k);
    if (list) list.push(s);
    else byKey.set(k, [s]);
  }
  const out: SessionInfo[] = [];
  for (const group of byKey.values()) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    group.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const newest = group[0];
    const named = group.find(g => g.title !== "Untitled session");
    out.push({
      ...newest,
      title: newest.title !== "Untitled session" ? newest.title : named?.title ?? newest.title,
      turns: Math.max(...group.map(g => g.turns)),
      createdMs: Math.min(...group.map(g => g.createdMs)),
      files: group.flatMap(g => g.files),
    });
  }
  return out;
}
