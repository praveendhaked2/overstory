// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const PAGE = 5;
  const app = /** @type {HTMLElement} */ (document.getElementById("app"));
  app.innerHTML = '<div id="list"></div><div id="dlg"></div>';
  const listEl = /** @type {HTMLElement} */ (document.getElementById("list"));
  const dlgEl = /** @type {HTMLElement} */ (document.getElementById("dlg"));
  /** @type {{collapsed: Record<string, boolean>, limits: Record<string, number>}} */
  const ui = Object.assign({ collapsed: {}, limits: {} }, vscode.getState() || {});
  // The last list is kept in webview state so a reload repaints instantly instead of blinking.
  /** @type {any} */ let state = ui.lastState || null;
  let lastListHtml = "";
  /** @type {any} */ let dialog = null; // { kind: "delete"|"missing", info, busy, error }

  const save = () => vscode.setState({ ...ui, lastState: state });
  const post = (/** @type {any} */ m) => vscode.postMessage(m);
  const esc = (/** @type {unknown} */ s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c);
  const ctx = (/** @type {object} */ o) => esc(JSON.stringify({ ...o, preventDefaultContextMenuItems: true }));
  const FILTERS = [["all", "All"], ["active", "Active"], ["claude", "Claude"], ["codex", "Codex"]];
  const STATE_TEXT = { running: "Running", waiting: "Waiting for your input", idle: "Not running / turn completed", missing: "Worktree folder missing. Click for options" };
  // Basic status icons: green dot = running, amber "!" = waiting for you, hollow circle = not running.
  const ICONS = {
    running: '<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" fill="currentColor"/></svg>',
    waiting: '<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="5.5" fill="currentColor"/><path d="M6 3v3.6" stroke="var(--vscode-sideBar-background, #000)" stroke-width="1.5" stroke-linecap="round"/><circle cx="6" cy="8.6" r=".9" fill="var(--vscode-sideBar-background, #000)"/></svg>',
    idle: '<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
    missing: '<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2 1.6"/></svg>',
  };
  const TRASH = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.6 6.5v5M9.4 6.5v5"/></svg>';
  const HOME = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2.5 7.5 8 3l5.5 4.5M4 6.5V13h3V9.5h2V13h3V6.5"/></svg>';
  const PIN = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M9.5 2.5 13.5 6.5 11 7.5 8.5 10l-.5 3L3 8l3-.5L8.5 5z"/><path d="M5.5 10.5 2.5 13.5"/></svg>';
  const PIN_FILLED = '<svg viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M9.5 2.5 13.5 6.5 11 7.5 8.5 10l-.5 3L3 8l3-.5L8.5 5z"/><path d="M5.5 10.5 2.5 13.5" fill="none"/></svg>';
  const PLUS = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 3v10M3 8h10"/></svg>';

  function matches(/** @type {any} */ s) {
    const f = state.filter;
    return f === "all" || (f === "active" ? s.state === "running" || s.state === "waiting" : s.agent === f);
  }

  function render() {
    renderList();
    renderDlg();
  }

  function renderDlg() {
    dlgEl.innerHTML = dialog ? renderDialog() : "";
    if (dialog) updateDialog();
  }

  function renderList() {
    if (!state) {
      listEl.innerHTML = '<div class="empty">Loading sessions…</div>';
      return;
    }
    let h = `<div class="filters" role="group" aria-label="Filter sessions">${FILTERS.map(([k, l]) => `<button class="chip${state.filter === k ? " on" : ""}" data-filter="${k}">${l}</button>`).join("")}</div>`;
    if (state.banner) h += `<div class="banner">${esc(state.banner)}<button class="ibtn x" data-act="dismiss" title="Dismiss">×</button></div>`;
    if (state.noWorkspace)
      h += `<div class="banner">This window isn't a saved workspace, so switching worktrees reloads VS Code. <button class="link" data-act="createWorkspace">Create workspace…</button><button class="ibtn x" data-act="dismissWs" title="Dismiss">×</button></div>`;
    if (!state.repos.length)
      h += '<div class="empty">No git repositories in this workspace yet.<div class="empty-act"><button class="btn primary" data-act="addProject">Add Git Project…</button></div></div>';
    for (const r of state.repos) h += renderRepo(r);
    if (state.repos.length) h += '<button class="new add-project" data-act="addProject">+ Add git project…</button>';
    if (state.repos.length) h += '<button class="new preserve" data-act="configurePreserve" title="Choose which ignored files (.env, node_modules…) every new worktree gets">⚙ Preserved files for new worktrees…</button>';
    // Skip identical repaints so hover and focus don't flicker on background refreshes.
    if (h !== lastListHtml) {
      listEl.innerHTML = h;
      lastListHtml = h;
    }
  }

  function renderRepo(/** @type {any} */ r) {
    const open = !ui.collapsed[r.key];
    const counts = `${r.total}${r.running ? ` · <span class="g">${r.running} running</span>` : ""}${r.waiting ? ` · <span class="a">${r.waiting} waiting</span>` : ""}`;
    let h = `<div class="repo" role="button" tabindex="0" aria-expanded="${open}" data-repo="${esc(r.key)}" data-vscode-context="${ctx({ webviewSection: "repo", repoKey: r.key })}" title="${esc(r.name)} is showing ${esc(r.currentLabel)}">
      <span class="chev">⌄</span><span class="name">${esc(r.name)}</span><span class="count">${counts}</span>
      <span class="cur ${r.currentPrimary ? "p" : "w"}">${esc(r.currentLabel)}</span>
      <span class="acts">${r.currentPrimary ? "" : `<button class="ibtn home" data-home="${esc(r.key)}" title="Switch back to the primary checkout (${esc(r.primaryLabel)})">${HOME}</button>`}<button class="ibtn" data-new="${esc(r.key)}" title="New session in ${esc(r.name)}…">${PLUS}</button></span></div>`;
    if (!open) return h;
    const list = r.sessions.filter(matches);
    if (!list.length) {
      h += `<div class="empty-repo">${r.sessions.length ? (state.filter === "active" ? "Nothing running or waiting." : "No sessions match this filter.") : `No sessions in the last ${state.maxAgeDays} days.`}</div>`;
    } else {
      // Pinned sessions are always shown and don't count toward the page.
      const pinned = list.filter(s => s.pinned);
      const rest = list.filter(s => !s.pinned);
      for (const s of pinned) h += renderSession(s);
      if (pinned.length && rest.length) h += '<div class="pin-sep" role="separator"></div>';
      const limit = Math.max(PAGE, ui.limits[r.key] || PAGE);
      // Keep the selected session visible even when it's beyond the page.
      const shown = rest.slice(0, limit);
      const sel = rest.findIndex(s => s.key === state.selected);
      if (sel >= limit) shown.push(rest[sel]);
      for (const s of shown) h += renderSession(s);
      const left = rest.length - Math.min(limit, rest.length);
      const links = [];
      if (left > 0) links.push(`<button class="link" data-more="${esc(r.key)}">+${Math.min(PAGE, left)} more</button>`, `<button class="link" data-all="${esc(r.key)}">Show all ${rest.length}</button>`);
      // Compact goes back to the first page whenever more than one page is showing.
      if (limit > PAGE && rest.length > PAGE) links.push(`<button class="link" data-less="${esc(r.key)}" title="Back to the first ${PAGE}">Compact</button>`);
      if (links.length) h += `<div class="more">${links.join("")}</div>`;
    }
    return h;
  }

  function renderSession(/** @type {any} */ s) {
    const missing = s.state === "missing";
    return `<div class="row${s.key === state.selected ? " sel" : ""}${s.inactive ? " inactive" : ""}" tabindex="0" role="button" data-open="${esc(s.key)}" title="${esc(s.tooltip)}" data-vscode-context="${ctx({ webviewSection: "session", sessionKey: s.key, sessionPinned: !!s.pinned })}">
      <span class="st ${s.state}" title="${esc(STATE_TEXT[s.state])}" aria-label="${esc(STATE_TEXT[s.state])}">${ICONS[s.state] || ICONS.idle}</span>
      <span class="t1">${esc(s.title)}</span>
      <span class="ago">${s.pinned ? `<span class="pin-mark" title="Pinned">${PIN_FILLED}</span>` : ""}${esc(s.ago)}</span>
      <span class="t2"><span class="agent ${s.agent}">${s.agent === "claude" ? "CLAUDE" : "CODEX"}</span><span class="wtag ${missing ? "gone" : s.wtPrimary ? "p" : "w"}">${esc(s.wtLabel)}</span><span class="meta${missing ? " bad" : ""}">· ${missing ? "folder missing" : `${s.turns} prompt${s.turns === 1 ? "" : "s"}`}</span></span>
      <span class="row-acts"><button class="ibtn pin${s.pinned ? " on" : ""}" data-pin="${esc(s.key)}" data-pinned="${s.pinned ? 1 : 0}" title="${s.pinned ? "Unpin" : "Pin to top"}" aria-label="${s.pinned ? "Unpin session" : "Pin session"}">${s.pinned ? PIN_FILLED : PIN}</button><button class="ibtn del" data-del="${esc(s.key)}" title="Delete session…" aria-label="Delete session">${TRASH}</button></span>
    </div>`;
  }

  // ---------- dialogs ----------

  function renderDialog() {
    const d = dialog;
    const i = d.info;
    let body = "";
    let foot = "";
    if (d.kind === "delete") {
      const wtSpan = `<span class="${i.primary ? "p" : "w"}"><code>${esc(i.wtLabel)}</code></span>`;
      let wtWhy = "";
      if (i.primary) wtWhy = `This is the repo's primary checkout. It's never removed, and its branch is never deleted.`;
      else if (i.others.length) wtWhy = `${i.others.length} other session${i.others.length > 1 ? "s" : ""} still use${i.others.length > 1 ? "" : "s"} this worktree (${i.others.map((/** @type {string} */ t) => `“${esc(t)}”`).join(", ")}). Delete ${i.others.length > 1 ? "them" : "it"} first to remove it.`;
      const wtText = i.missing ? "Clean up the leftover worktree record (the folder is already gone)" : `Also remove the worktree folder ${wtSpan}`;
      const dirty = i.dirty > 0 ? `<div class="warn bad">${i.dirty} uncommitted change${i.dirty > 1 ? "s" : ""} in this folder will be lost.</div>` : i.dirty < 0 ? `<div class="warn">Couldn't read this worktree's git status.</div>` : "";
      const cur = i.currentlyOpen ? `<div class="why">${esc(i.repoName)} is showing this worktree now. It will switch back to <span class="p"><code>${esc(i.primaryLabel)}</code></span>.</div>` : "";
      let brWarn = "";
      if (i.canDeleteBranch) {
        if (i.unpushed > 0) brWarn = `<div class="warn bad">${i.unpushed} commit${i.unpushed > 1 ? "s" : ""} exist only on this branch (never pushed, not on any other branch) and will be gone.</div>`;
        else if (i.ahead > 0) brWarn = `<div class="warn">Not merged into ${esc(i.primaryBranch)}: ${i.ahead} commit${i.ahead > 1 ? "s" : ""}.${i.upstream ? ` A copy stays on <b>${esc(i.upstream)}</b>.` : ""}</div>`;
        else brWarn = `<div class="why">Fully merged${i.upstream ? ` and pushed to ${esc(i.upstream)}` : ""}.</div>`;
      }
      const brWhy = i.primary ? "" : !i.canRemoveWt ? "Only possible together with removing the worktree." : i.canDeleteBranch ? "Remove the worktree first. Git won't delete a branch that's checked out." : i.branch ? "" : "This worktree is on a detached commit, so there's no branch to delete.";
      body = `<div>This deletes the ${esc(i.agentName)} session and its conversation history.<div class="path">${esc(i.file)}</div></div>
        ${i.runningText ? `<div class="warn">${esc(i.runningText)}</div>` : ""}
        <div class="opt-box${i.canRemoveWt ? "" : " dis"}">
          <label><input type="checkbox" id="optWt" ${i.canRemoveWt ? "" : "disabled"}><span>${i.primary ? `Remove worktree ${wtSpan}` : wtText}</span></label>
          ${i.canRemoveWt ? dirty + cur : `<div class="why">${wtWhy}</div>`}
        </div>
        ${i.primary ? "" : `<div class="opt-box dis" id="brBox">
          <label><input type="checkbox" id="optBr" disabled><span>Also delete the local branch <code>${esc(i.branch || "")}</code></span></label>
          <div class="why" id="brWhy">${brWhy}</div>
          <div id="brWarn" hidden>${brWarn}</div>
        </div>`}
        <div><div class="label">Will run</div><div class="code" id="cmds"></div></div>
        ${d.error ? `<div class="err">${esc(d.error)}</div>` : ""}`;
      foot = `<button class="btn" data-act="cancel" ${d.busy ? "disabled" : ""}>Cancel</button><button class="btn danger" data-act="confirmDelete" id="okBtn" ${d.busy ? "disabled" : ""}>${d.busy ? "Deleting…" : "Delete session"}</button>`;
      return `<div class="modal-bg" data-act="bg"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="dlgTitle"><h2 id="dlgTitle">Delete “${esc(i.title)}”?</h2><div class="mbody">${body}</div><div class="mfoot">${foot}</div></div></div>`;
    }
    // missing worktree
    body = `<div>The worktree folder no longer exists:<div class="path">${esc(i.wtPath)}</div></div>
      <div>${i.branchExists ? `Branch <code>${esc(i.branch)}</code> is still in the repo, so the worktree can be recreated from it.` : i.branch ? `Branch <code>${esc(i.branch)}</code> no longer exists either.` : "The worktree was on a detached commit."}</div>
      ${d.error ? `<div class="err">${esc(d.error)}</div>` : ""}`;
    foot = `<button class="btn" data-act="cancel" ${d.busy ? "disabled" : ""}>Cancel</button><button class="btn" data-act="hide" ${d.busy ? "disabled" : ""}>Hide session</button>${i.branchExists ? `<button class="btn primary" data-act="recreate" ${d.busy ? "disabled" : ""}>${d.busy ? "Recreating…" : "Recreate worktree and resume"}</button>` : ""}`;
    return `<div class="modal-bg" data-act="bg"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="dlgTitle"><h2 id="dlgTitle">The worktree for “${esc(i.title)}” is gone</h2><div class="mbody">${body}</div><div class="mfoot">${foot}</div></div></div>`;
  }

  function updateDialog() {
    if (!dialog || dialog.kind !== "delete") return;
    const i = dialog.info;
    const wt = /** @type {HTMLInputElement|null} */ (document.getElementById("optWt"));
    const br = /** @type {HTMLInputElement|null} */ (document.getElementById("optBr"));
    if (wt) wt.checked = !!dialog.rmWt;
    const canBr = !!dialog.rmWt && i.canDeleteBranch;
    if (!canBr) dialog.rmBranch = false;
    if (br) {
      br.disabled = !canBr || dialog.busy;
      br.checked = !!dialog.rmBranch;
      document.getElementById("brBox")?.classList.toggle("dis", !canBr);
      const why = document.getElementById("brWhy");
      if (why) why.hidden = canBr || !why.textContent;
      const warn = document.getElementById("brWarn");
      if (warn) warn.hidden = !canBr;
    }
    if (wt && dialog.busy) wt.disabled = true;
    const lines = [i.cmds.session];
    if (dialog.rmWt) lines.push(i.cmds.wt);
    if (dialog.rmBranch) lines.push(i.cmds.branch);
    const cmds = document.getElementById("cmds");
    if (cmds) cmds.textContent = lines.join("\n");
    const ok = document.getElementById("okBtn");
    if (ok && !dialog.busy) ok.textContent = dialog.rmBranch ? "Delete session, worktree and branch" : dialog.rmWt ? "Delete session and worktree" : "Delete session";
  }

  function openDialog(/** @type {any} */ d) {
    dialog = d;
    renderDlg();
    /** @type {HTMLElement|null} */ (document.querySelector('.modal [data-act="cancel"]'))?.focus();
  }

  function closeDialog() {
    dialog = null;
    renderDlg();
  }

  // ---------- events ----------

  app.addEventListener("click", e => {
    const t = /** @type {HTMLElement} */ (e.target);
    const el = (/** @type {string} */ sel) => /** @type {HTMLElement|null} */ (t.closest(sel));
    if (dialog) {
      const act = el("[data-act]")?.dataset.act;
      if (t.id === "optWt") { dialog.rmWt = /** @type {HTMLInputElement} */ (t).checked; updateDialog(); return; }
      if (t.id === "optBr") { dialog.rmBranch = /** @type {HTMLInputElement} */ (t).checked; updateDialog(); return; }
      if (dialog.busy) return;
      if (act === "cancel" || (act === "bg" && t.classList.contains("modal-bg"))) return closeDialog();
      if (act === "confirmDelete") {
        dialog.busy = true;
        dialog.error = undefined;
        renderDlg();
        post({ type: "confirmDelete", key: dialog.info.key, rmWt: !!dialog.rmWt, rmBranch: !!dialog.rmBranch });
      } else if (act === "recreate" || act === "hide") {
        dialog.busy = act === "recreate";
        const key = dialog.info.key;
        if (act === "hide") dialog = null;
        renderDlg();
        post({ type: "missingAction", key, action: act });
      }
      return;
    }
    const f = el("[data-filter]");
    if (f) return post({ type: "filter", filter: f.dataset.filter });
    if (el('[data-act="dismiss"]')) return post({ type: "dismissBanner" });
    if (el('[data-act="dismissWs"]')) return post({ type: "dismissWorkspaceBanner" });
    if (el('[data-act="createWorkspace"]')) return post({ type: "createWorkspace" });
    if (el('[data-act="addProject"]')) return post({ type: "addProject" });
    if (el('[data-act="configurePreserve"]')) return post({ type: "configurePreserve" });
    const home = el("[data-home]");
    if (home) return post({ type: "home", repoKey: home.dataset.home });
    const nw = el("[data-new]");
    if (nw) return post({ type: "new", repoKey: nw.dataset.new });
    const pin = el("[data-pin]");
    if (pin) return post({ type: "pin", key: pin.dataset.pin, pinned: pin.dataset.pinned !== "1" });
    const del = el("[data-del]");
    if (del) return post({ type: "delete", key: del.dataset.del });
    const more = el("[data-more]") || el("[data-all]") || el("[data-less]");
    if (more) {
      const k = more.dataset.more || more.dataset.all || more.dataset.less || "";
      ui.limits[k] = more.dataset.more ? Math.max(PAGE, ui.limits[k] || PAGE) + PAGE : more.dataset.all ? 1e9 : PAGE;
      save();
      return render();
    }
    const row = el("[data-open]");
    if (row) return post({ type: "open", key: row.dataset.open });
    const repo = el("[data-repo]");
    if (repo) {
      const k = repo.dataset.repo || "";
      ui.collapsed[k] = !ui.collapsed[k];
      save();
      render();
    }
  });

  app.addEventListener("keydown", e => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (e.key === "Escape" && dialog && !dialog.busy) return closeDialog();
    if (dialog) return;
    if ((e.key === "Delete" || (e.key === "Backspace" && e.metaKey)) && t.dataset.open) {
      e.preventDefault();
      return post({ type: "delete", key: t.dataset.open });
    }
    if (e.key.toLowerCase() === "p" && t.dataset.open && !e.metaKey && !e.ctrlKey) {
      const s = state?.repos.flatMap((/** @type {any} */ r) => r.sessions).find((/** @type {any} */ x) => x.key === t.dataset.open);
      if (s) post({ type: "pin", key: s.key, pinned: !s.pinned });
      return;
    }
    if ((e.key === "Enter" || e.key === " ") && (t.dataset.open || t.dataset.repo)) {
      e.preventDefault();
      t.click();
    }
  });

  window.addEventListener("message", e => {
    const m = e.data;
    if (m.type === "state") {
      state = m.state;
      save();
      // Keep the dialog and focus stable while the list refreshes underneath.
      const focusKey = /** @type {HTMLElement|null} */ (document.activeElement)?.dataset?.open;
      renderList();
      if (focusKey) /** @type {HTMLElement|null} */ (document.querySelector(`[data-open="${CSS.escape(focusKey)}"]`))?.focus();
    } else if (m.type === "deleteDialog") openDialog({ kind: "delete", info: m.info, rmWt: false, rmBranch: false });
    else if (m.type === "missingDialog") openDialog({ kind: "missing", info: m.info });
    else if (m.type === "dialogDone") {
      if (m.error && dialog) {
        dialog.busy = false;
        dialog.error = m.error;
        renderDlg();
      } else closeDialog();
    } else if (m.type === "collapseAll") {
      for (const r of state?.repos ?? []) ui.collapsed[r.key] = true;
      save();
      render();
    }
  });

  render();
  post({ type: "ready" });
})();
