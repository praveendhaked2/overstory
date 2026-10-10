import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { FromWebview, ToWebview, UiState } from "./types.ts";

/** The sidebar list, rendered as a webview so rows can carry chips, tags and an in-place delete dialog. */
export class SessionsViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "worktreeSessions.sessions";
  private view?: vscode.WebviewView;
  private ready = false;
  private queue: ToWebview[] = [];
  private lastState?: UiState;
  private extensionUri: vscode.Uri;
  private onMessage: (m: FromWebview) => void;

  constructor(extensionUri: vscode.Uri, onMessage: (m: FromWebview) => void) {
    this.extensionUri = extensionUri;
    this.onMessage = onMessage;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    const media = vscode.Uri.joinPath(this.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = randomBytes(16).toString("base64");
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(media, "sessions.css"));
    const js = view.webview.asWebviewUri(vscode.Uri.joinPath(media, "sessions.js"));
    view.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Worktree Sessions</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
    view.webview.onDidReceiveMessage((m: FromWebview) => {
      if (m.type === "ready") {
        this.ready = true;
        if (this.lastState) void view.webview.postMessage({ type: "state", state: this.lastState } satisfies ToWebview);
        for (const q of this.queue.splice(0)) void view.webview.postMessage(q);
        return;
      }
      this.onMessage(m);
    });
    view.onDidDispose(() => {
      this.view = undefined;
      this.ready = false;
    });
  }

  setState(state: UiState): void {
    this.lastState = state;
    if (this.view && this.ready) void this.view.webview.postMessage({ type: "state", state } satisfies ToWebview);
  }

  /** Sends a message, revealing the view first if needed (dialogs). */
  async post(msg: ToWebview, reveal = false): Promise<void> {
    if (reveal && !this.view?.visible) await vscode.commands.executeCommand(`${SessionsViewProvider.viewId}.focus`);
    if (this.view && this.ready) void this.view.webview.postMessage(msg);
    else this.queue.push(msg);
  }
}
