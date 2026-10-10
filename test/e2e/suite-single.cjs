// Runs in a window that has only one repo folder open (no .code-workspace).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

const log = (...a) => console.log("[e2e:single]", ...a);

module.exports.run = async function run() {
  const root = process.env.WTS_E2E_ROOT;
  const solo = path.join(root, "solo");
  const api = await vscode.extensions.getExtension("praveen-dhaked2.worktree-sessions").activate();
  await api.ready;
  assert.equal(vscode.workspace.workspaceFile, undefined, "single-folder window");

  const target = path.join(root, "solo.code-workspace");
  const orig = { save: vscode.window.showSaveDialog, exec: vscode.commands.executeCommand };
  let pageOpts;
  let opened;
  api.setPreservePicker(async (_uri, opts) => {
    pageOpts = opts;
    return [".env", ".env.*", "node_modules", ".tool-versions", "re:^config/.+\\.json$"];
  });
  vscode.window.showSaveDialog = async o => {
    assert.match(o.defaultUri.fsPath, /solo\.code-workspace$/, "default name from the project");
    return vscode.Uri.file(target);
  };
  vscode.commands.executeCommand = async (id, ...args) => {
    if (id === "vscode.openFolder") { opened = args[0]; return; }
    return orig.exec.call(vscode.commands, id, ...args);
  };
  try {
    await orig.exec.call(vscode.commands, "worktreeSessions.createWorkspace");
  } finally {
    vscode.window.showSaveDialog = orig.save;
    vscode.commands.executeCommand = orig.exec;
  }
  assert.equal(pageOpts.mode, "create");
  assert.equal(pageOpts.current, undefined, "never configured");
  assert.deepEqual(pageOpts.repos.map(r => r.name), ["solo"]);
  assert.equal(opened?.fsPath, target, "window reopens in the new workspace");
  const ws = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.equal(ws.folders[0].name, "· workspace", "placeholder first");
  assert.ok(fs.existsSync(ws.folders[0].path), "placeholder folder exists");
  assert.deepEqual(ws.folders[1], { path: "solo" }, "project path relative to the workspace file");
  assert.deepEqual(ws.settings["worktreeSessions.preserve"], [".env", ".env.*", "node_modules", ".tool-versions", "re:^config/.+\\.json$"]);
  log("create workspace OK");
};
