/* ============================================================
   HCCL Player Ranking - UI layer

   Renders into #view-ranking. All data and math live in
   ranking-engine.js (window.HCCLRanking); this file only draws.

   Layout: three panels on ONE page - Batting, Bowling, All-Rounder -
   each with its own title, Pos/Player/Rating table (top 10, expandable)
   and an "* as of {date}" footer.

   Import: admins/moderators get a "Weekly Stats Import" card (season
   picker + CSV file button). Viewers never see it - hidden both here
   (not rendered) and by the body:not(.can-edit) CSS gate, the same
   two-layer convention the rest of the app uses. Importing parses the
   CSV, updates that season in the local history and recalculates; the
   tables below refresh instantly via the engine's onChange event.
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
    if (!canEditApp() || !eng || typeof eng.getSeasons !== "function") return "";
    const { seasons, next } = eng.getSeasons();
    const latest = seasons.length ? seasons[seasons.length - 1].id : next.id;
    const opts = seasons.map(s =>
      `<option value="${esc(s.id)}" ${s.id === latest ? "selected" : ""}>${esc(s.id)} - update</option>`)
      .concat(`<option value="${esc(next.id)}">${esc(next.id)} - new season</option>`)
      .join("");
    return `
      <div class="card rank-import">
        <h3>⬆ Weekly Stats Import</h3>
        <p class="hint">Pick the season, then choose the weekly CSV export from the stats system.
          Rankings recalculate instantly on this device commit the same CSV to the repo to publish it for everyone.</p>
        <div class="form-row">
          <select id="rankSeasonSel" title="Season this CSV belongs to">${opts}</select>
          <label class="btn btn-dark file-btn">⬆ Import CSV
            <input type="file" id="rankCsvFile" accept=".csv,text/csv" hidden />
          </label>
        </div>
      </div>`;
  }

  function onImportFile(e) {
    const file = e.target.files && e.target.files[0];
    const sel = document.getElementById("rankSeasonSel");
    e.target.value = ""; // allow re-picking the same filename next week
    if (!file || !sel) return;
    const seasonId = sel.value;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const res = engine().importSeasonCSV(seasonId, String(reader.result));
        if (res.ok) notify(`Imported ${res.count} players into ${res.seasonId} - rankings updated`, "good");
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
        Import a season CSV above, or add the exports to the <b>HCCL Player Stats</b> folder.</p></div>`;
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
