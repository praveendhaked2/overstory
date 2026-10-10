const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(what, fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for: ${what}`);
}
const log = (...a) => console.log("[e2e]", ...a);

module.exports.run = async function run() {
  const root = process.env.WTS_E2E_ROOT;
  const app = path.join(root, "app");
  const featX = path.join(root, "app-worktrees", "feat-x");
  const featY = path.join(root, "app-worktrees", "feat-y");
  const ext = vscode.extensions.getExtension("praveendhaked2.overstory");
  assert.ok(ext, "extension is loaded");
  const api = await ext.activate();
  await api.ready;

  const appView = () => api.views().find(v => v.repo.name === "app");
  await waitFor("3 sessions listed", () => appView()?.sessions.length === 3);
  let view = appView();
  assert.equal(api.views().length, 1, "the non-git _ws folder is ignored");
  assert.equal(view.repo.current.primary, true);
  assert.equal(view.repo.worktrees.length, 3);
  const byTitle = t => appView().sessions.find(s => s.s.title === t);
  const sx = byTitle("Fix flaky test in X");
  assert.equal(sx.wt.branch, "feat/x");
  log("listed sessions:", view.sessions.map(s => `${s.s.title} [${s.wt.branch}]`).join(", "));

  // Click a session: only the app folder swaps, a terminal starts.
  await vscode.commands.executeCommand("worktreeSessions.openSession", { kind: "session", view: sx });
  await waitFor("app folder swapped to feat/x", () => vscode.workspace.workspaceFolders[1].uri.fsPath === featX);
  assert.equal(vscode.workspace.workspaceFolders[1].name, "app ⎇ feat/x");
  assert.equal(vscode.workspace.workspaceFolders[0].name, "_ws", "other folders untouched");
  const term = await waitFor("session terminal", () => vscode.window.terminals.find(t => t.name === "claude · app ⎇ feat/x · aaaaaaaa"));
  assert.equal(term.creationOptions.cwd, featX);
  await waitFor("model shows feat/x as current", () => appView()?.repo.current.branch === "feat/x");
  assert.ok(appView().sessions.find(s => s.key === sx.key).attached, "session shows as attached");
  log("swap + terminal OK");

  // Pinning: the oldest session jumps to the top and stays there; unpinning restores the order.
  const firstKey = () => appView().sessions[0].key;
  const oldest = appView().sessions[appView().sessions.length - 1];
  assert.notEqual(firstKey(), oldest.key);
  await vscode.commands.executeCommand("worktreeSessions.pinSession", { sessionKey: oldest.key });
  await waitFor("pinned session first", () => firstKey() === oldest.key);
  await vscode.commands.executeCommand("worktreeSessions.unpinSession", { sessionKey: oldest.key });
  await waitFor("unpinned session back in place", () => firstKey() !== oldest.key);
  log("pin / unpin OK");

  // Clicking again focuses the same terminal instead of opening a second one.
  const count = vscode.window.terminals.length;
  await vscode.commands.executeCommand("worktreeSessions.openSession", { kind: "session", view: byTitle("Fix flaky test in X") });
  await sleep(500);
  assert.equal(vscode.window.terminals.length, count, "no duplicate terminal");

  // Back to the primary checkout.
  await vscode.commands.executeCommand("worktreeSessions.switchToPrimary", { kind: "repo", view: appView() });
  await waitFor("app folder back on main", () => vscode.workspace.workspaceFolders[1].uri.fsPath === app);
  assert.equal(vscode.workspace.workspaceFolders[1].name, "app");
  log("switch to primary OK");

  // Delete the feat/y session together with its worktree and branch.
  const yKey = byTitle("Spike in Y").key;
  const info = await api.deleteInfo(yKey);
  assert.equal(info.canRemoveWt, true);
  assert.equal(info.canDeleteBranch, true);
  assert.equal(info.unpushed, 1, "the y commit exists only on feat/y");
  assert.match(info.cmds.branch, /branch -D feat\/y$/);
  const err = await api.performDelete(yKey, true, true);
  assert.equal(err, undefined);
  assert.ok(!fs.existsSync(featY), "worktree removed");
  assert.equal(execFileSync("git", ["branch", "--list", "feat/y"], { cwd: app }).toString().trim(), "", "branch deleted");
  await waitFor("Y session gone", () => !byTitle("Spike in Y"));
  log("delete session + worktree + branch OK");

  // The primary checkout's session can only delete the session itself.
  const mainInfo = await api.deleteInfo(byTitle("Question on main").key);
  assert.equal(mainInfo.primary, true);
  assert.equal(mainInfo.canRemoveWt, false);
  assert.equal(mainInfo.canDeleteBranch, false);
  log("primary checkout protection OK");

  // The delete command opens the dialog in the sidebar webview (no native modal).
  let nativeAsked = false;
  const orig = vscode.window.showWarningMessage;
  vscode.window.showWarningMessage = async () => { nativeAsked = true; };
  try {
    await vscode.commands.executeCommand("worktreeSessions.deleteSession", { sessionKey: byTitle("Question on main").key });
  } finally {
    vscode.window.showWarningMessage = orig;
  }
  assert.equal(nativeAsked, false);
  assert.ok(byTitle("Question on main"), "opening the dialog deletes nothing");
  log("delete dialog routed to webview OK");

  // Let the sidebar finish taking focus from the dialog step before opening a quick pick.
  await sleep(1500);
  await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
  await sleep(300);

  // New session in a new worktree: typed name, base picked in the second step, .env copied, folder swapped.
  const origQp = vscode.window.createQuickPick;
  const origPick = vscode.window.showQuickPick;
  const accept = () => vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
  /** Each entry drives one quick pick in order: a function that chooses the item to accept. */
  let script = [];
  const seen = [];
  vscode.window.createQuickPick = () => {
    const qp = origQp();
    const step = script.shift();
    setTimeout(async () => {
      const item = await step(qp);
      seen.push({ title: qp.title, labels: qp.items.map(i => i.label) });
      await sleep(200);
      qp.activeItems = [item];
      await sleep(100);
      await accept();
    }, 500);
    return qp;
  };
  vscode.window.showQuickPick = async items => (await items).find(i => i.agent === "claude");
  const typeName = name => async qp => {
    qp.value = name;
    return waitFor(`create item ${name}`, () => qp.items.find(i => i.create === name), 5000);
  };
  const pickBase = ref => async qp => waitFor(`base ${ref}`, () => qp.items.find(i => i.ref === ref), 5000);
  try {
    script = [typeName("feat/z"), pickBase("main")];
    await vscode.commands.executeCommand("worktreeSessions.newSessionInRepo", { repoKey: appView().repo.key });
    const featZ = path.join(root, "app-worktrees", "feat-z");
    await waitFor("app folder on new worktree feat/z", () => vscode.workspace.workspaceFolders[1].uri.fsPath === featZ);
    assert.equal(fs.readFileSync(path.join(featZ, ".env"), "utf8"), "TOKEN=1\n", ".env copied");
    assert.ok(fs.lstatSync(path.join(featZ, "node_modules")).isSymbolicLink(), "node_modules linked");
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: featZ }).toString().trim(), "", "the link doesn't make the worktree dirty");
    assert.ok(vscode.window.terminals.find(t => t.name.startsWith("claude · app ⎇ feat/z · ")), "terminal for new session");
    const base = seen.find(x => x.title.includes("base it on"));
    assert.ok(base, "base-branch picker shown");
    assert.match(base.labels[0], /main$/, "the default base is listed first");

    // Automatic name, based on feat/x instead of the default.
    await sleep(1000);
    script = [async qp => waitFor("auto item", () => qp.items.find(i => i.action === "auto"), 5000), pickBase("feat/x")];
    await vscode.commands.executeCommand("worktreeSessions.newSessionInRepo", { repoKey: appView().repo.key });
    const autoFolder = await waitFor("app folder on an auto-named worktree", () => {
      const p = vscode.workspace.workspaceFolders[1].uri.fsPath;
      return /app-worktrees\/[a-z]+-[a-z]+$/.test(p) ? p : undefined;
    });
    const head = d => execFileSync("git", ["rev-parse", "HEAD"], { cwd: d }).toString().trim();
    assert.equal(head(autoFolder), head(featX), "auto worktree starts from feat/x");
    log("auto-named worktree:", path.basename(autoFolder));
  } finally {
    vscode.window.createQuickPick = origQp;
    vscode.window.showQuickPick = origPick;
  }

  // Add Git Project: a repo is appended; a plain folder is refused.
  const origOpen = vscode.window.showOpenDialog;
  const origWarn = vscode.window.showWarningMessage;
  let warned = "";
  vscode.window.showOpenDialog = async () => [vscode.Uri.file(path.join(root, "extra")), vscode.Uri.file(path.join(root, "not-a-repo"))];
  vscode.window.showWarningMessage = async m => { warned = m; };
  try {
    await vscode.commands.executeCommand("worktreeSessions.addProject");
  } finally {
    vscode.window.showOpenDialog = origOpen;
    vscode.window.showWarningMessage = origWarn;
  }
  await waitFor("extra added", () => vscode.workspace.workspaceFolders.some(f => f.uri.fsPath === path.join(root, "extra")));
  assert.match(warned, /not git repositories: not-a-repo/);
  assert.equal(vscode.workspace.workspaceFolders[0].name, "_ws", "first folder untouched");
  log("add git project OK");

  // The real Worktree Files page opens as an editor tab; closing it changes nothing.
  const before = JSON.stringify(vscode.workspace.getConfiguration("worktreeSessions").get("preserve"));
  const pending = vscode.commands.executeCommand("worktreeSessions.configurePreserve");
  await waitFor("Worktree Files tab", () => vscode.window.tabGroups.all.flatMap(g => g.tabs).find(t => t.label === "Worktree Files"));
  await sleep(1500);
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  await pending;
  assert.equal(JSON.stringify(vscode.workspace.getConfiguration("worktreeSessions").get("preserve")), before, "closing the page saves nothing");
  log("worktree files page OK");
  log("new worktree session OK");
};
