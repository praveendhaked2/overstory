// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const app = /** @type {HTMLElement} */ (document.getElementById("app"));
  const esc = (/** @type {unknown} */ s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c);
  /** @type {any} */ let model = null;
  /** @type {any} */ let preview = null;
  let mode = "glob";
  let draft = "";
  let seq = 0;
  let timer = 0;

  const isRegex = (/** @type {string} */ p) => p.startsWith("re:");
  const regexErr = (/** @type {string} */ src) => {
    try {
      new RegExp(src);
      return "";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  const patterns = () => [...model.presets.filter((/** @type {any} */ p) => p.checked).flatMap((/** @type {any} */ p) => p.patterns), ...model.custom];
  // A folder is linked, a file copied; for a custom entry we can only guess from the preview.
  const EXAMPLES = [".tool-versions", "config/*.local.json", "*.pem", ".cache", "re:^apps/[^/]+/\\.env$"];

  function draftProblem() {
    const v = draft.trim();
    if (!v) return "";
    if (mode === "regex") return regexErr(v) ? `Invalid regex: ${regexErr(v)}` : "";
    if (v.includes("\n")) return "One entry at a time.";
    return "";
  }

  function draftHint() {
    const v = draft.trim();
    if (mode === "regex") return v ? `Matched against the path from the repo root, e.g. apps/web/.env` : "A JavaScript regular expression, matched against paths like apps/web/.env";
    if (!v) return "A name like .tool-versions matches in any folder. A path with / (config/*.json) starts at the repo root. * and ** work as in .gitignore.";
    return v.includes("/") ? `Matches ${v} from the repo root` : `Matches “${v}” in any folder`;
  }

  function render() {
    if (!model) {
      app.innerHTML = "";
      return;
    }
    const create = model.mode === "create";
    const pats = patterns();
    const total = preview ? preview.repos.reduce((/** @type {number} */ n, /** @type {any} */ r) => n + r.items.length, 0) : 0;
    const files = preview ? preview.repos.reduce((/** @type {number} */ n, /** @type {any} */ r) => n + r.items.filter((/** @type {any} */ i) => i.action === "copy").length, 0) : 0;
    const prob = draftProblem();

    app.innerHTML = `<div class="page">
      ${create ? '<p class="eyebrow">New workspace · step 1 of 2</p>' : ""}
      <h1>Files for new worktrees</h1>
      <p class="lead">Git doesn't check out ignored files in a new worktree, so things like <code>.env</code> are missing. Choose what each new worktree should get from the main checkout. <b>Files are copied. Folders are linked</b> to the main checkout's copy, so nothing large is duplicated.${create ? " You can change this later: <b>Preserved files for new worktrees…</b> at the bottom of the sidebar, or the gear button in its title bar." : ""}</p>
      <div class="cols">
        <div>
          <section>
            <h2>Common</h2>
            <div class="list">
              ${model.presets.map((/** @type {any} */ p, /** @type {number} */ i) => `
                <label class="item">
                  <input type="checkbox" data-preset="${i}" ${p.checked ? "checked" : ""}>
                  <span class="name">${esc(p.label)}</span>
                  <span class="tags">${p.found ? '<span class="found">found in project</span>' : ""}<span class="badge ${p.action}">${p.action === "link" ? "LINK" : "COPY"}</span></span>
                  <span class="sub"><code>${esc(p.patterns.join("  "))}</code><span>· ${esc(p.detail)}</span></span>
                </label>`).join("")}
            </div>
          </section>
          <section>
            <h2>Custom <span class="sum">${model.custom.length ? `${model.custom.length} entr${model.custom.length === 1 ? "y" : "ies"}` : ""}</span></h2>
            <div class="list">
              ${model.custom.length ? model.custom.map((/** @type {string} */ c, /** @type {number} */ i) => {
                const re = isRegex(c);
                const err = re ? regexErr(c.slice(3)) : "";
                return `<div class="custom-row"><span class="badge ${re ? "regex" : "glob"}">${re ? "REGEX" : "GLOB"}</span><code>${esc(re ? c.slice(3) : c)}</code><button class="x" data-remove="${i}" title="Remove" aria-label="Remove ${esc(c)}">×</button>${err ? `<span class="err">${esc(err)}</span>` : ""}</div>`;
              }).join("") : '<div class="empty-custom">No custom entries. Add file names, folders, globs or a regex below.</div>'}
            </div>
            <div class="adder">
              <span class="seg" role="group" aria-label="Entry type"><button data-mode="glob" class="${mode === "glob" ? "on" : ""}">Glob</button><button data-mode="regex" class="${mode === "regex" ? "on" : ""}">Regex</button></span>
              <input class="input${prob ? " invalid" : ""}" id="draft" placeholder="${mode === "regex" ? "^apps/[^/]+/\\.env$" : ".tool-versions  ·  config/*.local.json  ·  .cache"}" value="${esc(draft)}" aria-label="New ${mode} entry" spellcheck="false">
              <button class="btn" id="add" ${!draft.trim() || prob ? "disabled" : ""}>Add</button>
            </div>
            <div class="hint${prob ? " bad" : ""}" id="hint">${esc(prob || draftHint())}</div>
            <div class="examples">Try: ${EXAMPLES.map(e => `<button class="chip" data-example="${esc(e)}">${esc(e.startsWith("re:") ? `regex ${e.slice(3)}` : e)}</button>`).join("")}</div>
          </section>
        </div>
        <div class="preview">
          <section>
            <h2>Preview <span class="sum">${preview ? `${files} file${files === 1 ? "" : "s"} copied · ${total - files} folder${total - files === 1 ? "" : "s"} linked` : "scanning…"}</span></h2>
            <div class="${preview && preview.seq !== seq ? "scanning" : ""}">
              ${(preview?.repos ?? model.repos.map((/** @type {string} */ n) => ({ name: n, items: [], truncated: false }))).map((/** @type {any} */ r) => `
                <div class="repo">
                  <div class="repo-h">${esc(r.name)}<span class="sum">${r.items.length}${r.truncated ? "+" : ""} match${r.items.length === 1 ? "" : "es"}</span></div>
                  ${r.items.length ? r.items.map((/** @type {any} */ i) => `<div class="match"><span class="badge ${i.action}">${i.action === "link" ? "LINK" : "COPY"}</span><code>${esc(i.rel)}</code></div>`).join("") : `<div class="none">${pats.length ? "Nothing in this repo matches." : "Nothing selected."}</div>`}
                  ${r.truncated ? '<div class="more">…and more</div>' : ""}
                </div>`).join("")}
            </div>
          </section>
        </div>
      </div>
    </div>
    <div class="foot"><div class="foot-in">
      <span class="note">${pats.length ? `${pats.length} rule${pats.length === 1 ? "" : "s"}` : "New worktrees will get nothing extra"}</span>
      <button class="btn" data-act="cancel">Cancel</button>
      <button class="btn primary" data-act="done">${create ? "Continue: choose where to save" : "Save"}</button>
    </div></div>`;
  }

  function refreshPreview() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      seq++;
      vscode.postMessage({ type: "preview", patterns: patterns(), seq });
      render();
    }, 200);
  }

  function rerenderKeepingInput() {
    const had = document.activeElement?.id === "draft";
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById("draft"));
    const pos = input?.selectionStart ?? draft.length;
    render();
    if (had) {
      const again = /** @type {HTMLInputElement} */ (document.getElementById("draft"));
      again.focus();
      again.setSelectionRange(pos, pos);
    }
  }

  function addDraft() {
    const v = draft.trim();
    if (!v || draftProblem()) return;
    const entry = mode === "regex" ? `re:${v}` : v;
    if (!model.custom.includes(entry)) model.custom.push(entry);
    draft = "";
    render();
    /** @type {HTMLInputElement} */ (document.getElementById("draft")).focus();
    refreshPreview();
  }

  app.addEventListener("change", e => {
    const t = /** @type {HTMLInputElement} */ (e.target);
    if (t.dataset.preset !== undefined) {
      model.presets[+t.dataset.preset].checked = t.checked;
      refreshPreview();
    }
  });

  app.addEventListener("input", e => {
    const t = /** @type {HTMLInputElement} */ (e.target);
    if (t.id !== "draft") return;
    draft = t.value;
    const prob = draftProblem();
    t.classList.toggle("invalid", !!prob);
    const hint = /** @type {HTMLElement} */ (document.getElementById("hint"));
    hint.textContent = prob || draftHint();
    hint.classList.toggle("bad", !!prob);
    /** @type {HTMLButtonElement} */ (document.getElementById("add")).disabled = !draft.trim() || !!prob;
  });

  app.addEventListener("keydown", e => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (t.id === "draft" && e.key === "Enter") {
      e.preventDefault();
      addDraft();
    }
  });

  app.addEventListener("click", e => {
    const t = /** @type {HTMLElement} */ (e.target);
    const el = (/** @type {string} */ s) => /** @type {HTMLElement|null} */ (t.closest(s));
    const m = el("[data-mode]");
    if (m) {
      mode = m.dataset.mode || "glob";
      return rerenderKeepingInput();
    }
    if (el("#add")) return addDraft();
    const ex = el("[data-example]");
    if (ex) {
      const v = ex.dataset.example || "";
      mode = v.startsWith("re:") ? "regex" : "glob";
      draft = mode === "regex" ? v.slice(3) : v;
      render();
      /** @type {HTMLInputElement} */ (document.getElementById("draft")).focus();
      return;
    }
    const rm = el("[data-remove]");
    if (rm) {
      model.custom.splice(+(rm.dataset.remove || 0), 1);
      render();
      return refreshPreview();
    }
    const act = el("[data-act]")?.dataset.act;
    if (act === "cancel") vscode.postMessage({ type: "cancel" });
    if (act === "done") {
      if (draft.trim() && !draftProblem()) addDraft();
      vscode.postMessage({ type: "done", patterns: patterns() });
    }
  });

  window.addEventListener("message", e => {
    const m = e.data;
    if (m.type === "init") {
      model = { mode: m.mode, presets: m.presets, custom: m.custom, repos: m.repos };
      render();
      refreshPreview();
    } else if (m.type === "preview") {
      if (m.seq < (preview?.seq ?? 0)) return;
      preview = m;
      rerenderKeepingInput();
    }
  });

  vscode.postMessage({ type: "ready" });
})();
