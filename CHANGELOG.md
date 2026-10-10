# Changelog

## 0.7.2

- Renamed to **Overstory** (extension id `praveendhaked2.overstory`). Commands, views and the `worktreeSessions.*` settings keep their ids, so existing settings carry over; uninstall the old "Worktree Sessions" entry after installing.
- The Worktree Files page is easy to reopen after the workspace exists: a gear button in the sidebar title bar, a **Preserved files for new worktrees…** link under the repo list, a hint on the create page, and an "Edit Preserved Files…" button on the "Workspace ready" message.

## 0.7.1

- Fix: a resumed Codex session showed once per file (Codex continues it in a new rollout file with the same id). Files of one session are merged into one row; deleting removes all of them.

## 0.7.0

- Pin sessions (pin icon on hover, right-click, or P on a focused row). Pinned sessions stay at the top of their repo, aren't counted in the 5-session page, and are unpinned automatically when deleted.

## 0.6.0

- Worktree Files page (editor tab) replaces the two quick picks: common presets with COPY/LINK badges, custom entries as glob or regex with inline validation and examples, and a live per-repo preview of what will be copied or linked.
- Regex entries (`re:<expression>`) in `worktreeSessions.preserve`.

## 0.5.1

- Removed the "+ New session in …" row; the "+" on each repo header is now always visible.

## 0.5.0

- Create Workspace: from a single folder or untitled workspace, writes a `.code-workspace` with a placeholder first folder and reopens in it, then continues the switch you clicked. Offered by a sidebar banner and on the first switch.
- Add Git Project…: add one or more repos to the workspace (non-git folders are skipped).
- Preserved files (`worktreeSessions.preserve`): presets for .env files, node_modules, .venv/venv, Claude local settings and .envrc, plus custom names/patterns. Files are copied; folders are symlinked to the primary checkout and excluded from git status.

## 0.4.1

- The worktree picker names each worktree by its folder, with the branch as secondary text; branches are only listed in the base-branch step.

## 0.4.0

- New worktrees ask which branch to base the new branch on: the primary checkout's branch first (Enter keeps the old default), then the open worktree's branch, local and remote branches by recent commit (5 each, "Show all"), any typed branch/tag/commit, and "Fetch from remotes". New branches don't track their base.
- "New worktree with an automatic name" picks a free name like `brisk-otter` (prefix via `worktreeSessions.autoNamePrefix`).

## 0.3.2

- Sessions sort by state: waiting for input, then running, then open in a terminal but idle, then the rest by last activity. Inside the active groups the order only changes when a state changes.

## 0.3.1

- "Compact" link next to "+5 more" and "Show all" returns a repo to its first 5 sessions.

## 0.3.0

- Session icons show state: running (green dot), waiting for input (amber !), not running / completed (hollow circle).
- State comes from turn markers and pending tool calls in the session file, plus the process tree to tell a running command from one waiting for approval.
- Repo headers and the status bar count running and waiting sessions; the "Has terminal" filter is now "Active".

## 0.2.2

- Command to add the placeholder first folder at any time.

## 0.2.1

- No more blank-and-redraw when switching: the sidebar repaints instantly from its last state and skips identical repaints.
- Switching the repo that is the workspace's first folder offers to add a placeholder first folder, since VS Code restarts every extension when the first folder changes.

## 0.2.0

- Sidebar redrawn as a webview matching the design: two-line rows with agent chips, worktree tags and status dots.
- Each repo shows 5 sessions, with "+5 more", "Show all" and "Show less".
- Delete dialog inside the sidebar, with checkboxes for the worktree and branch and a preview of the commands it will run.
- Worktree picker: "New worktree" first, 5 most relevant worktrees, then "Show all"; typing searches all of them.
- Restart banner listing how many session terminals did not come back.

## 0.1.0

- Sessions view for Claude Code and Codex, grouped by repo and tagged by worktree.
- Click to swap only that repo's folder to the worktree and resume in a terminal.
- New sessions in existing or new worktrees, with ignored files copied over.
- Delete a session, optionally with its worktree and local branch.
- Recovery after window reload and restart; missing-worktree handling.
