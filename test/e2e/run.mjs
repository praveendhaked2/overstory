// End-to-end test: launches the installed VS Code with this extension on a throwaway workspace.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wts-e2e-")));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();
const encode = p => p.replace(/[^a-zA-Z0-9]/g, "-");
const line = o => JSON.stringify(o) + "\n";

fs.mkdirSync(path.join(root, "_ws"));
const app = path.join(root, "app");
fs.mkdirSync(app);
git(app, "init", "-q", "-b", "main");
git(app, "config", "user.email", "e2e@example.com");
git(app, "config", "user.name", "e2e");
fs.writeFileSync(path.join(app, "README.md"), "app\n");
fs.writeFileSync(path.join(app, ".gitignore"), ".env\nnode_modules/\n");
fs.mkdirSync(path.join(app, "node_modules", "dep"), { recursive: true });
fs.writeFileSync(path.join(app, "node_modules", "dep", "index.js"), "1");
fs.writeFileSync(path.join(app, ".env"), "TOKEN=1\n");
git(app, "add", ".");
git(app, "commit", "-qm", "init");
const featX = path.join(root, "app-worktrees", "feat-x");
const featY = path.join(root, "app-worktrees", "feat-y");
git(app, "worktree", "add", "-q", "-b", "feat/x", featX);
git(app, "worktree", "add", "-q", "-b", "feat/y", featY);
fs.writeFileSync(path.join(featY, "y.txt"), "y\n");
git(featY, "add", ".");
git(featY, "commit", "-qm", "y work");

const claudeHome = path.join(root, "claude-home");
const codexHome = path.join(root, "codex-home");
fs.mkdirSync(codexHome, { recursive: true });
const addClaude = (cwd, id, title) => {
  const dir = path.join(claudeHome, "projects", encode(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`),
    line({ type: "user", cwd, sessionId: id, timestamp: new Date().toISOString(), message: { content: "hello" } }) +
    line({ type: "ai-title", aiTitle: title, sessionId: id }));
};
addClaude(featX, "aaaaaaaa-0000-4000-8000-000000000001", "Fix flaky test in X");
addClaude(featY, "bbbbbbbb-0000-4000-8000-000000000002", "Spike in Y");
addClaude(app, "cccccccc-0000-4000-8000-000000000003", "Question on main");

// A second repo to add with "Add Git Project", plus a plain folder that should be refused.
const extra = path.join(root, "extra");
fs.mkdirSync(extra);
git(extra, "init", "-q", "-b", "main");
fs.mkdirSync(path.join(root, "not-a-repo"));
// A repo opened on its own (no workspace) for the "Create workspace" flow.
const solo = path.join(root, "solo");
fs.mkdirSync(solo);
git(solo, "init", "-q", "-b", "main");
fs.writeFileSync(path.join(solo, ".env"), "SOLO=1\n");

const wsFile = path.join(root, "e2e.code-workspace");
fs.writeFileSync(wsFile, JSON.stringify({
  folders: [{ path: "_ws" }, { path: "app" }],
  settings: {
    "worktreeSessions.claudeCommand": "echo claude",
    "worktreeSessions.codexCommand": "echo codex",
    "git.worktreeIncludeFiles": [".env"],
    "worktreeSessions.preserve": ["node_modules"],
    "security.workspace.trust.enabled": false,
  },
}, null, 2));

try {
  await runTests({
    vscodeExecutablePath: process.env.VSCODE_PATH || "/Applications/Visual Studio Code.app/Contents/MacOS/Code",
    extensionDevelopmentPath: path.resolve(here, "../.."),
    extensionTestsPath: path.join(here, "suite.cjs"),
    launchArgs: [wsFile, "--disable-extensions", "--user-data-dir", path.join(root, "user-data"), "--skip-welcome", "--skip-release-notes", "--disable-workspace-trust"],
    extensionTestsEnv: { CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome, WTS_E2E_ROOT: root },
  });
  await runTests({
    vscodeExecutablePath: process.env.VSCODE_PATH || "/Applications/Visual Studio Code.app/Contents/MacOS/Code",
    extensionDevelopmentPath: path.resolve(here, "../.."),
    extensionTestsPath: path.join(here, "suite-single.cjs"),
    launchArgs: [solo, "--disable-extensions", "--user-data-dir", path.join(root, "user-data-2"), "--skip-welcome", "--skip-release-notes", "--disable-workspace-trust"],
    extensionTestsEnv: { CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome, WTS_E2E_ROOT: root },
  });
  console.log("E2E PASSED");
} catch (e) {
  console.error("E2E FAILED", e);
  process.exitCode = 1;
} finally {
  if (!process.env.KEEP) fs.rmSync(root, { recursive: true, force: true });
}
