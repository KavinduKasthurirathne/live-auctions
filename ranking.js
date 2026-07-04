/* ============================================================
   HCCL Player Ranking - UI layer

   Renders into #view-ranking. All data and math live in
   ranking-engine.js (window.HCCLRanking); this file only draws.

   Layout: three panels on ONE page - Batting, Bowling, All-Rounder -
   each with its own title, Pos/Player/Rating table (top 10, expandable)
   and an "* as of {date}" footer.

   Data: rankings are computed from the committed all-time combined
   sheet (HCCL Statistics.csv = career) plus an optional ongoing-season
   sheet (= current form). Admins/moderators get an import card to load
   the ongoing season's CSV after each match/week. Viewers never see it -
   hidden both here (not rendered) and by the body:not(.can-edit) CSS
   gate, the same two-layer convention the rest of the app uses. The
   tables refresh instantly via the engine's onChange event.
   ============================================================ */
(function () {
  "use strict";

  const TOP_N = 10; // rows visible before expanding

  const CATS = [
    { key: "batting",    label: "🏏 Batting" },
    { key: "bowling",    label: "🎯 Bowling" },
    { key: "allrounder", label: "⭐ All-Rounder" },
  ];

  // View state (persists while the page is open).
  const ui = { expanded: { batting: false, bowling: false, allrounder: false } };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  const engine = () => window.HCCLRanking || null;
  // Same convention as fantasy.js: editors (admin/moderator) or fully-offline mode.
  function canEditApp() {
    const H = window.HCCL;
    return !H || !H.configured || H.canEdit();
  }
  function notify(msg, kind) {
    if (typeof window.toast === "function") window.toast(msg, kind);
    else console.log("[ranking]", msg);
  }

  function posCell(pos) {
    const medal = pos === 1 ? "🥇" : pos === 2 ? "🥈" : pos === 3 ? "🥉" : "";
    return medal || pos;
  }

  /* ---------- weekly import card (admins/moderators only) ---------- */
  function importCardHtml() {
    const eng = engine();
    if (!canEditApp() || !eng || typeof eng.importSeasonCSV !== "function") return "";
    const st = typeof eng.getStatus === "function" ? eng.getStatus() : {};
    const status = `All-time sheet: <b>${esc(st.baselineDate || "not loaded")}</b>
      · Season update: <b>${esc(st.seasonDate || "none yet")}</b>`;
    return `
      <div class="card rank-import">
        <h3>⬆ Ongoing Season Update</h3>
        <p class="hint">After a match (or weekly), import the ongoing season's CSV export -
          rankings recalculate instantly on this device. To publish it for everyone, commit the
          same file as <b>HCCL Player Stats/Current Season.csv</b>. Career numbers come from the
          committed all-time sheet (<b>HCCL Statistics.csv</b>); replace it at season end.</p>
        <div class="form-row">
          <label class="btn btn-dark file-btn">⬆ Import season CSV
            <input type="file" id="rankCsvFile" accept=".csv,text/csv" hidden />
          </label>
        </div>
        <p class="hint">${status}</p>
      </div>`;
  }

  function onImportFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // allow re-picking the same filename next time
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const res = engine().importSeasonCSV(String(reader.result));
        if (res.ok) notify(`Imported ${res.count} players - rankings updated`, "good");
        else notify(res.error || "Import failed", "bad");
      } catch (err) {
        console.error("ranking import failed:", err);
        notify("Couldn't import that CSV", "bad");
      }
    };
    reader.onerror = () => notify("Couldn't read that file", "bad");
    reader.readAsText(file);
  }

  /* ------------------------- ranking tables ------------------------ */
  function tableFor(cat) {
    const eng = engine();
    const data = eng ? eng.getRanking(cat) : { loading: false, available: false, rows: [], updated: null };

    if (data.loading) {
      return `<div class="rank-card"><p class="rank-empty">Computing rankings…</p></div>`;
    }
    if (!data.available) {
      return `<div class="rank-card"><p class="rank-empty">No ranking data yet.<br/>
        Add the combined all-time sheet as <b>HCCL Player Stats/HCCL Statistics.csv</b>
        (or import a season CSV above) and reload.</p></div>`;
    }

    const rows = data.rows;
    const expanded = !!ui.expanded[cat];
    const shown = expanded ? rows : rows.slice(0, TOP_N);
    const hasMore = rows.length > TOP_N;

    const body = shown.map(r => `
      <tr>
        <td class="rk-pos">${posCell(r.pos)}</td>
        <td class="rk-name">${esc(r.name)}</td>
        <td class="rk-rating">${esc(r.rating)}</td>
      </tr>`).join("");

    const expander = hasMore ? `
      <button class="rank-expand" type="button" data-rank-expand="${cat}" aria-expanded="${expanded}">
        <span>${expanded ? `Show top ${TOP_N}` : `Show all ${rows.length}`}</span>
        <span class="rank-chevron" aria-hidden="true">▾</span>
      </button>` : "";

    return `
      <div class="rank-card">
        <table class="rank-table">
          <thead>
            <tr><th class="rk-pos">Pos</th><th class="rk-name">Player Name</th><th class="rk-rating">Rating</th></tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
        ${expander}
        <p class="rank-foot">* as of ${esc(data.updated || "-")}</p>
      </div>`;
  }

  function render() {
    const view = document.getElementById("view-ranking");
    if (!view) return;
    view.innerHTML = `
      <div class="view-head"><h2>PLAYER RANKING</h2></div>
      ${importCardHtml()}
      <div class="rank-sections">
        ${CATS.map(c => `
          <section class="rank-section">
            <h3 class="rank-sec-title">${c.label}</h3>
            ${tableFor(c.key)}
          </section>`).join("")}
      </div>`;
    const file = view.querySelector("#rankCsvFile");
    if (file) file.onchange = onImportFile;
  }

  function onClick(e) {
    const ex = e.target.closest("[data-rank-expand]");
    if (ex) { const c = ex.getAttribute("data-rank-expand"); ui.expanded[c] = !ui.expanded[c]; render(); }
  }

  function init() {
    const view = document.getElementById("view-ranking");
    if (!view) return;
    view.addEventListener("click", onClick);
    // Re-draw when the engine (re)computes, and when auth/role state
    // changes (shows/hides the import card after sign-in).
    const eng = engine();
    if (eng) eng.onChange(render);
    if (window.HCCL && typeof window.HCCL.onChange === "function") window.HCCL.onChange(render);
    render();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
