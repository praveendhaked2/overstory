import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { compileMatchers, globToRegExp, normalizePattern, preserveIntoWorktree, regexError, scanMatches } from "../src/core/copyFiles.ts";
import {
  addWorktree,
  branchExists,
  commitsAhead,
  deleteBranch,
  dirtyCount,
  excludeFromGit,
  listWorktrees,
  locateRepo,
  parseWorktreePorcelain,
  pruneWorktrees,
  realpath,
  removeWorktree,
  unpushedCommits,
} from "../src/core/git.ts";
import { branchSlug, encodeClaudeProjectDir, isInside, shellQuote, worktreePathFor } from "../src/core/paths.ts";
import { SessionScanner } from "../src/core/sessions.ts";

const tmp = () => realpath(fs.mkdtempSync(path.join(os.tmpdir(), "wts-test-")));
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

test("paths helpers", () => {
  assert.equal(encodeClaudeProjectDir("/Users/me/repos/my_app.v2"), "-Users-me-repos-my-app-v2");
  assert.equal(branchSlug("feat/ocr-scope"), "feat-ocr-scope");
  assert.equal(worktreePathFor("${repoParent}/${repoName}-worktrees", "/r/app", "fix/a"), "/r/app-worktrees/fix-a");
  assert.ok(isInside("/a/b/c", "/a/b"));
  assert.ok(isInside("/a/b", "/a/b"));
  assert.ok(!isInside("/a/bc", "/a/b"));
  assert.equal(shellQuote("abc-123"), "abc-123");
  assert.equal(shellQuote("it's here"), `'it'\\''s here'`);
});

test("worktree porcelain parsing", () => {
  const out = [
    "worktree /r/app", "HEAD aaa", "branch refs/heads/dev_main", "",
    "worktree /r/app-worktrees/feat-x", "HEAD bbb", "branch refs/heads/feat/x", "",
    "worktree /r/app-worktrees/gone", "HEAD ccc", "detached", "prunable gitdir file points to non-existent location", "",
  ].join("\n");
  const wts = parseWorktreePorcelain(out);
  assert.equal(wts.length, 3);
  assert.deepEqual(wts.map(w => [w.primary, w.branch, w.detached, w.prunable]), [
    [true, "dev_main", false, false],
    [false, "feat/x", false, false],
    [false, undefined, true, true],
  ]);
});

test("glob matching", () => {
  assert.ok(globToRegExp(".env").test(".env"));
  assert.ok(!globToRegExp(".env").test("a/.env"));
  assert.ok(globToRegExp("**/.env").test(".env"));
  assert.ok(globToRegExp("**/.env").test("DataClassifier/.env"));
  assert.ok(globToRegExp(".env.*").test(".env.local"));
  assert.ok(!globToRegExp(".env.*").test(".envx"));
  assert.equal(normalizePattern("node_modules"), "**/node_modules");
  assert.equal(normalizePattern("/.env"), ".env");
  assert.equal(normalizePattern("config/local.json"), "config/local.json");
  assert.equal(normalizePattern(".venv/"), "**/.venv");
  // Regex entries
  assert.equal(normalizePattern("re:^apps/[^/]+/\\.env$"), "re:^apps/[^/]+/\\.env$");
  const [re] = compileMatchers(["re:^apps/[^/]+/\\.env$"]);
  assert.ok(re.test("apps/web/.env"));
  assert.ok(!re.test("apps/web/src/.env"));
  assert.ok(regexError("re:(unclosed"));
  assert.equal(compileMatchers(["re:(unclosed", ".env"]).length, 1, "invalid regex is dropped");
});

test("git worktree lifecycle", async () => {
  const root = tmp();
  const repo = path.join(root, "app");
  fs.mkdirSync(path.join(repo, "sub"), { recursive: true });
  sh(repo, "init", "-q", "-b", "dev_main");
  sh(repo, "config", "user.email", "t@example.com");
  sh(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "sub", "a.txt"), "a");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".env\nnode_modules/\n");
  fs.mkdirSync(path.join(repo, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(repo, "node_modules", "left-pad", "index.js"), "module.exports = 1;");
  fs.writeFileSync(path.join(repo, ".env"), "SECRET=1");
  fs.writeFileSync(path.join(repo, "sub", ".env"), "SUB=1");
  sh(repo, "add", ".");
  sh(repo, "commit", "-qm", "init");

  const loc = await locateRepo(path.join(repo, "sub"));
  assert.equal(loc?.toplevel, repo);

  const dir = worktreePathFor("${repoParent}/${repoName}-worktrees", repo, "feat/x");
  await addWorktree(repo, dir, "feat/x", { create: true, base: "dev_main" });
  const loc2 = await locateRepo(dir);
  assert.equal(loc2?.commonDir, loc?.commonDir, "worktrees share one common dir");

  const preview = await scanMatches(repo, [".env", "node_modules"]);
  assert.deepEqual(preview.items.map(i => `${i.action}:${i.rel}`).sort(), ["copy:.env", "copy:sub/.env", "link:node_modules"]);
  const kept = await preserveIntoWorktree(repo, dir, [".env", "node_modules"]);
  assert.deepEqual(kept.copied.sort(), [".env", "sub/.env"]);
  assert.deepEqual(kept.linked, ["node_modules"]);
  assert.equal(fs.readFileSync(path.join(dir, "sub", ".env"), "utf8"), "SUB=1");
  assert.ok(fs.lstatSync(path.join(dir, "node_modules")).isSymbolicLink(), "node_modules is linked, not copied");
  assert.equal(fs.readFileSync(path.join(dir, "node_modules", "left-pad", "index.js"), "utf8"), "module.exports = 1;");
  const again = await preserveIntoWorktree(repo, dir, [".env", "node_modules"]);
  assert.deepEqual([again.copied, again.linked], [[], []], "never overwrites");
  assert.equal(await dirtyCount(dir), 1, "a node_modules/ rule doesn't hide a symlink…");
  await excludeFromGit(dir, kept.linked);
  await excludeFromGit(dir, kept.linked);
  assert.equal(await dirtyCount(dir), 0, "…until it's excluded");
  assert.equal(fs.readFileSync(path.join(loc!.commonDir, "info", "exclude"), "utf8").split("/node_modules").length - 1, 1, "excluded once");

  let wts = await listWorktrees(repo);
  assert.equal(wts.length, 2);
  assert.equal(wts[0].primary, true);
  assert.equal(wts[1].branch, "feat/x");

  assert.equal(await dirtyCount(dir), 0);
  fs.writeFileSync(path.join(dir, "new.txt"), "x");
  assert.equal(await dirtyCount(dir), 1);
  sh(dir, "add", ".");
  sh(dir, "commit", "-qm", "work");
  assert.equal(await commitsAhead(repo, "feat/x", "dev_main"), 1);
  assert.equal(await unpushedCommits(repo, "feat/x"), 1);

  fs.writeFileSync(path.join(dir, "dirty.txt"), "x");
  await assert.rejects(removeWorktree(repo, dir, false), "dirty worktree needs force");
  await removeWorktree(repo, dir, true);
  assert.ok(!fs.existsSync(dir));
  assert.ok(fs.existsSync(path.join(repo, "node_modules", "left-pad", "index.js")), "removing the worktree leaves the linked node_modules intact");
  await assert.rejects(deleteBranch(repo, "feat/x", false), "unmerged branch needs -D");
  await deleteBranch(repo, "feat/x", true);
  assert.equal(await branchExists(repo, "feat/x"), false);

  // A worktree whose folder vanished is reported as prunable, then pruned.
  const dir2 = path.join(root, "app-worktrees", "gone");
  await addWorktree(repo, dir2, "gone", { create: true, base: "dev_main" });
  fs.rmSync(dir2, { recursive: true, force: true });
  wts = await listWorktrees(repo);
  assert.equal(wts.find(w => w.branch === "gone")?.prunable, true);
  await pruneWorktrees(repo);
  assert.equal((await listWorktrees(repo)).length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("session scanning: Claude and Codex, incremental", async () => {
  const home = tmp();
  const claudeHome = path.join(home, ".claude");
  const codexHome = path.join(home, ".codex");
  const cwd = "/Users/me/repos/app-worktrees/feat-x";
  const pdir = path.join(claudeHome, "projects", encodeClaudeProjectDir(cwd));
  fs.mkdirSync(pdir, { recursive: true });
  const cid = "11111111-2222-3333-4444-555555555555";
  const cfile = path.join(pdir, `${cid}.jsonl`);
  const line = (o: object) => JSON.stringify(o) + "\n";
  fs.writeFileSync(cfile,
    line({ type: "queue-operation", sessionId: cid }) +
    line({ type: "attachment", cwd, sessionId: cid, timestamp: "2026-10-09T10:00:00Z" }) +
    line({ type: "user", cwd, sessionId: cid, isMeta: true, message: { content: "<command-name>/clear</command-name>" } }) +
    line({ type: "user", cwd, sessionId: cid, message: { content: [{ type: "text", text: "Add  per-image\nOCR scope" }] } }) +
    line({ type: "user", cwd, sessionId: cid, message: { content: [{ type: "tool_result", content: "ok" }] } }));

  const day = new Date();
  const ddir = path.join(codexHome, "sessions", String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
  fs.mkdirSync(ddir, { recursive: true });
  const xid = "01a11fdd-f17c-78f0-9d11-0d49f357fb52";
  const xfile = path.join(ddir, `rollout-2026-10-09T14-23-21-${xid}.jsonl`);
  fs.writeFileSync(xfile,
    line({ type: "session_meta", payload: { id: xid, cwd, timestamp: "2026-10-09T08:53:21.433Z" } }) +
    line({ type: "event_msg", payload: { type: "user_message", message: "# AGENTS.md instructions for x" } }) +
    line({ type: "event_msg", payload: { type: "user_message", message: "Review the diff" } }));
  // Newer Codex CLIs record prompts only as response items.
  const yid = "01a11fdd-0000-78f0-9d11-0d49f357fb53";
  fs.writeFileSync(path.join(ddir, `rollout-2026-10-09T15-00-00-${yid}.jsonl`),
    line({ type: "session_meta", payload: { id: yid, cwd, timestamp: "2026-10-09T09:00:00Z" } }) +
    line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for /x" }] } }) +
    line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>…</environment_context>" }] } }) +
    line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the flaky ETL test" }] } }));
  fs.writeFileSync(path.join(codexHome, "session_index.jsonl"), line({ id: xid, thread_name: "Review OCR diff" }));

  const scanner = new SessionScanner({ claudeHome, codexHome, maxAgeDays: 30 });
  let found = await scanner.scan([cwd]);
  const c = found.find(s => s.agent === "claude")!;
  const x = found.find(s => s.id === xid)!;
  assert.equal(c.id, cid);
  assert.equal(c.cwd, cwd);
  assert.equal(c.title, "Add per-image OCR scope");
  assert.equal(c.turns, 1);
  assert.equal(x.id, xid);
  assert.equal(x.title, "Review OCR diff");
  assert.equal(x.turns, 1);
  const y = found.find(s => s.id === yid)!;
  assert.equal(y.title, "Fix the flaky ETL test");
  assert.equal(y.turns, 1);

  // Appended lines are picked up; an AI title wins over the first prompt.
  fs.appendFileSync(cfile, line({ type: "user", cwd, sessionId: cid, message: { content: "second prompt" } }) + line({ type: "ai-title", aiTitle: "OCR scope setting", sessionId: cid }));
  found = await scanner.scan([cwd]);
  const c2 = found.find(s => s.agent === "claude")!;
  assert.equal(c2.turns, 2);
  assert.equal(c2.title, "OCR scope setting");

  // A resumed Codex session continues in another file with the same id: one entry, newest state.
  const part = path.join(ddir, `rollout-2026-10-09T16-00-00-${xid}_01a11fdd-aaaa-78f0-9d11-0d49f357fb99.jsonl`);
  fs.writeFileSync(part,
    line({ type: "session_meta", payload: { id: xid, cwd, timestamp: "2026-10-09T10:00:00Z" } }) +
    line({ type: "event_msg", payload: { type: "task_started" } }));
  fs.utimesSync(part, new Date(), new Date(Date.now() + 5000));
  found = await scanner.scan([cwd]);
  const xs = found.filter(s => s.id === xid);
  assert.equal(xs.length, 1, "one row per session");
  assert.equal(xs[0].files.length, 2);
  assert.equal(xs[0].file, part, "newest file supplies the state");
  assert.equal(xs[0].turnOpen, true);
  assert.equal(xs[0].title, "Review OCR diff");
  assert.equal(xs[0].turns, 1, "largest prompt count across files");

  // Sessions of unrelated folders aren't read.
  assert.equal((await scanner.scan(["/Users/me/other"])).filter(s => s.agent === "claude").length, 0);
  fs.rmSync(home, { recursive: true, force: true });
});
