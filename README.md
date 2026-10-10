# Overstory

The overstory is the top layer of a forest: the view over every tree. This one is a VS Code sidebar that lists your **Claude Code** and **Codex** sessions across every repo and git worktree in a multi-root workspace.

Click a session and only that repo's workspace folder switches to the session's worktree; every other repo stays where it is. The session then resumes in its own terminal with `claude --resume` or `codex resume`, so rewind and editing earlier messages keep working.

## Install

Search for **Overstory** in the Extensions view, or run:

```bash
code --install-extension praveendhaked2.overstory
```

Marketplace page: https://marketplace.visualstudio.com/items?itemName=praveendhaked2.overstory

To install without the Marketplace, download `overstory-<version>.vsix` from the [latest release](https://github.com/praveendhaked2/overstory/releases/latest) and run `code --install-extension overstory-<version>.vsix`, or choose **Install from VSIX…** from the `...` menu in the Extensions view. Updates are manual on that path.

## Features

- **Sessions grouped by repo**: waiting for input first, then running, then open but idle, then the rest newest first. Each row shows the title, an agent chip (CLAUDE / CODEX), its worktree (`⌂ main` for the primary checkout, `⎇ feat/x` for linked worktrees), prompt count and last activity. Each repo shows 5 sessions, with **+5 more**, **Show all** and **Compact** (back to 5). Repos collapse, and filter chips narrow the list to Active (running or waiting), Claude or Codex.
- **Pin sessions** with the pin icon on hover, right-click, or `P` on a focused row. Pinned sessions stay at the top of their repo; the 5-session limit and **+5 more / Show all / Compact** apply to the rest below.
- **Click to resume.** Swaps only that repo's folder(s) to the worktree, then focuses the session's terminal, or opens one and runs the resume command. If the terminal is open but the agent has exited, the resume command runs in it again.
- **Status icons:** green dot = running; amber `!` = waiting for your input (a question, or a permission prompt); hollow circle = not running or turn completed; red dashed = worktree folder missing. The status bar shows how many are running and waiting.
- **New session** (`+` on the view or on a repo): "New worktree with an automatic name" and "New worktree…" sit at the top, followed by the 5 most relevant worktrees and "Show all"; typing a name searches every worktree or creates a new one. A new branch then asks for its base: the primary checkout's branch (default), the open worktree's branch, any local or remote branch, or a typed tag/commit. New worktrees go in `<repo>-worktrees/<branch>` next to the repo, and get your ignored files (`.env` and so on) copied over.
- **Delete session** (bin icon on hover, or Delete key): a dialog inside the sidebar deletes the session and, with checkboxes, removes the worktree and deletes its local branch. It shows the exact commands before running them, and warns about uncommitted changes and commits that exist only on that branch. The primary checkout, and worktrees other sessions still use, are never removed.
- **Create a workspace in one step.** Opened just a project folder? The sidebar offers **Create workspace…** (also asked on the first switch). It writes a `.code-workspace` with a small placeholder folder first, so switching never reloads VS Code, then reopens the window in it and finishes what you clicked.
- **Add Git Project…** (sidebar title bar, or the link under the list) adds more repos to the workspace. Plain folders are skipped with a note.
- **Preserved files.** New worktrees don't get ignored files from git, so you choose what each one gets: `.env` files, `node_modules`, Python `.venv`/`venv`, Claude Code local settings, `.envrc`, plus your own entries: names, globs (`config/*.local.json`) or a regex (matched against the path from the repo root). Files are copied; folders are **linked** to the primary checkout's copy (no reinstall, nothing duplicated) and kept out of `git status`. A **Worktree Files** page shows a live preview of exactly what will be copied or linked in each repo. It opens when creating the workspace, and any time afterwards from the gear button in the sidebar title bar, the **Preserved files for new worktrees…** link under the repo list, or **Configure Preserved Files…** in the Command Palette. Changes apply to worktrees created from then on.
- **Switch back to primary** (`⌂` on a repo) and **Switch Worktree…** (repo context menu) change folders without starting a session.
- **Survives reloads and restarts.** Sessions are read from disk (`~/.claude/projects`, `~/.codex/sessions`), and the workspace file remembers each repo's worktree. After a window reload, running terminals are matched to their sessions again.
- **Right-click** a session to copy its ID, reveal its file or hide it; right-click a repo to switch worktree.

## How it works

| Piece | Source |
| --- | --- |
| Repos and worktrees | `git worktree list --porcelain` for every git folder in the workspace. Folders of one repo are grouped by their shared `.git` dir, so subfolders of a monorepo move together. |
| Claude Code sessions | `~/.claude/projects/<encoded cwd>/<id>.jsonl` (or `$CLAUDE_CONFIG_DIR`). Title: your `/rename`, else Claude's generated title, else the first prompt. |
| Codex sessions | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (or `$CODEX_HOME`). Title: the thread name from `session_index.jsonl`, else the first prompt. |
| Matching | A session belongs to the deepest worktree that contains its working folder. |
| Running / waiting | Read from the end of the session file: an open turn (Claude: no `turn_duration` yet; Codex: `task_started` without `task_complete`) is running. A pending question tool (`AskUserQuestion`, `ExitPlanMode`, `request_user_input`) is waiting. A pending shell command with no command process under the agent (via `ps`) is waiting for approval, as is an Edit/Write that hasn't finished after a few quiet seconds. Agents started elsewhere count when their command line names the session (`claude --resume <id>`); otherwise an open turn with no writes for 10 minutes counts as not running. |

Session files are read incrementally: after the first scan, only new bytes are read.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `worktreeSessions.claudeCommand` | `claude` | Command for Claude sessions; add flags here. |
| `worktreeSessions.codexCommand` | `codex` | Command for Codex sessions. |
| `worktreeSessions.worktreeRoot` | `${repoParent}/${repoName}-worktrees` | Where new worktrees go. |
| `worktreeSessions.autoNamePrefix` | `""` | Prefix for automatic worktree names, e.g. `wt/`. |
| `worktreeSessions.preserve` | `[]` | Ignored files/folders each new worktree gets. Bare names match in any folder; `re:<regex>` entries match the path from the repo root; folders are linked, files copied. Set via the sidebar gear button / **Configure Preserved Files…**. `git.worktreeIncludeFiles` is honoured too. |
| `worktreeSessions.copyFiles` | `[]` | Deprecated alias of `preserve`. |
| `worktreeSessions.maxAgeDays` | `30` | Hide sessions older than this. |
| `worktreeSessions.defaultAgent` | `ask` | `claude`, `codex` or `ask`. |

## Good to know

- **The first workspace folder.** VS Code restarts all extensions when the *first* folder of a workspace changes. Workspaces created by this extension start with an empty "· workspace" folder so that never happens; for an existing workspace, the first switch offers to add it (or run **Add Placeholder First Folder**).
- **Linked folders are shared.** A linked `node_modules` or `.venv` is the primary checkout's copy: installing a package in one worktree installs it for all. Removing a worktree removes only the link.
- **Folder names.** A swapped folder is renamed `name ⎇ branch` so the Explorer shows which worktree you're on; switching back to the primary checkout restores the plain name. Both are saved in your `.code-workspace`.
- **Quitting VS Code** stops the agent processes. The conversations are on disk; click a session to resume it. An action that was cut off mid-way may need asking again.
- **Waiting for input** is inferred from the session file and the process tree, not read from the agent's screen, so it can lag a few seconds or misjudge an unusual tool.
- **Deleting a Codex session** uses `codex delete <id>`; if that isn't available, the rollout file goes to the Trash.

## Develop

```bash
npm install
npm test            # unit + git integration tests
npm run test:e2e    # runs the extension in the installed VS Code on a throwaway workspace
npm run package     # typecheck, test, build, and write dist/overstory.vsix
```

Install the package with `code --install-extension dist/overstory.vsix`.

### Release

Bump `version` in `package.json`, add a CHANGELOG entry, commit, then tag and push:

```bash
git tag v0.7.3
git push origin main v0.7.3
```

The release workflow runs the checks, attaches the `.vsix` to a GitHub release and publishes the same package to the Marketplace. Publishing needs a `VSCE_PAT` repository secret: an Azure DevOps personal access token with the **Marketplace: Manage** scope for all accessible organizations.
