import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { normalizePattern, regexError, scanMatches } from "./core/copyFiles.ts";
import { PRESETS } from "./workspaceSetup.ts";

export interface PreservePanelOptions {
  mode: "create" | "edit";
  /** Current setting; undefined when never configured (presets found in the project start ticked). */
  current: string[] | undefined;
  repos: { name: string; root: string }[];
}

type FromPanel = { type: "ready" } | { type: "preview"; patterns: string[]; seq: number } | { type: "done"; patterns: string[] } | { type: "cancel" };

/**
 * An editor-tab page for choosing which ignored files every new worktree gets, with a live preview of
 * what matches in each repo. Resolves with the pattern list, or undefined when cancelled/closed.
 */
export function openPreservePanel(extensionUri: vscode.Uri, opts: PreservePanelOptions): Promise<string[] | undefined> {
  const media = vscode.Uri.joinPath(extensionUri, "media");
  const panel = vscode.window.createWebviewPanel("worktreeSessions.preserve", opts.mode === "create" ? "New Workspace: Worktree Files" : "Worktree Files", vscode.ViewColumn.Active, {
    enableScripts: true,
    localResourceRoots: [media],
  });
  panel.iconPath = vscode.Uri.joinPath(media, "activity.svg");
  const nonce = randomBytes(16).toString("base64");
  const w = panel.webview;
  w.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${w.asWebviewUri(vscode.Uri.joinPath(media, "preserve.css"))}"><title>Worktree Files</title></head>
<body><div id="app"></div><script nonce="${nonce}" src="${w.asWebviewUri(vscode.Uri.joinPath(media, "preserve.js"))}"></script></body></html>`;

  const found = (probe: string[]) => opts.repos.some(r => probe.some(rel => fs.existsSync(path.join(r.root, rel))));
  const currentSet = new Set((opts.current ?? []).map(normalizePattern));
  const presets = PRESETS.map(p => {
    const isFound = found(p.probe);
    return {
      label: p.label,
      patterns: p.patterns,
      detail: p.detail,
      action: p.patterns.some(x => ["node_modules", ".venv", "venv"].includes(x)) ? "link" : "copy",
      found: isFound,
      checked: opts.current ? p.patterns.every(x => currentSet.has(normalizePattern(x))) : isFound && p.defaultWhenFound,
    };
  });
  const presetSet = new Set(PRESETS.flatMap(p => p.patterns.map(normalizePattern)));
  const custom = (opts.current ?? []).filter(x => !presetSet.has(normalizePattern(x)));

  return new Promise(resolve => {
    let settled = false;
    const finish = (v: string[] | undefined) => {
      if (settled) return;
      settled = true;
      resolve(v);
      panel.dispose();
    };
    w.onDidReceiveMessage(async (m: FromPanel) => {
      if (m.type === "ready") {
        void w.postMessage({ type: "init", mode: opts.mode, presets, custom, repos: opts.repos.map(r => r.name) });
      } else if (m.type === "preview") {
        const repos = await Promise.all(opts.repos.map(async r => ({ name: r.name, ...(await scanMatches(r.root, m.patterns, 60)) })));
        void w.postMessage({ type: "preview", seq: m.seq, repos });
      } else if (m.type === "done") {
        const bad = m.patterns.find(p => p.startsWith("re:") && regexError(p));
        if (bad) return void vscode.window.showErrorMessage(`Invalid regex ${bad.slice(3)}: ${regexError(bad)}`);
        finish(m.patterns);
      } else if (m.type === "cancel") finish(undefined);
    });
    panel.onDidDispose(() => {
      if (!settled) {
        settled = true;
        resolve(undefined);
      }
    });
  });
}
