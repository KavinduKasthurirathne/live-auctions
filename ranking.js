/* ============================================================
   HCCL Player Ranking — UI layer

   Renders into #view-ranking. All data and math live in
   ranking-engine.js (window.HCCLRanking); this file only draws.

   UX note: Player Ranking is a *dedicated ranking view* — a calm,
   read-only "who's on top" board kept separate from the Auctions and
   Fantasy flows (different mental model: season standings, not live
   bidding or fantasy points). It still lives in the main navbar so it
   feels like a first-class destination, and reuses the app's tab/card/
   table styling so it fits in naturally. Each category is a sub-tab,
   the table shows the top 10 by default, and an expand arrow reveals
   the rest — keeping the default view focused and uncluttered.
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
  const ui = { cat: "batting", expanded: { batting: false, bowling: false, allrounder: false } };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  const engine = () => window.HCCLRanking || null;

  function posCell(pos) {
    const medal = pos === 1 ? "🥇" : pos === 2 ? "🥈" : pos === 3 ? "🥉" : "";
    return medal || pos;
  }

  function tableFor(cat) {
    const eng = engine();
    const data = eng ? eng.getRanking(cat) : { loading: false, available: false, rows: [], updated: null };

    if (data.loading) {
      return `<div class="rank-card"><p class="rank-empty">Computing rankings…</p></div>`;
    }
    if (!data.available) {
      return `<div class="rank-card"><p class="rank-empty">No ranking data yet.<br/>
        Add the season CSV exports to the <b>HCCL Player Stats</b> folder and reload.</p></div>`;
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
        <p class="rank-foot">* as of ${esc(data.updated || "—")}</p>
      </div>`;
  }

  function render() {
    const view = document.getElementById("view-ranking");
    if (!view) return;
    view.innerHTML = `
      <div class="view-head"><h2>PLAYER RANKING</h2></div>
      <nav class="subtabs rank-nav" id="rankSubtabs">
        ${CATS.map(c => `<button class="rank-subtab${ui.cat === c.key ? " active" : ""}" type="button" data-rank="${c.key}">${c.label}</button>`).join("")}
      </nav>
      <div class="rank-panels">
        ${CATS.map(c => `<div class="rank-panel${ui.cat === c.key ? " active" : ""}" data-rank-panel="${c.key}">${tableFor(c.key)}</div>`).join("")}
      </div>`;
  }

  function onClick(e) {
    const tab = e.target.closest(".rank-subtab");
    if (tab) { ui.cat = tab.getAttribute("data-rank"); render(); return; }
    const ex = e.target.closest("[data-rank-expand]");
    if (ex) { const c = ex.getAttribute("data-rank-expand"); ui.expanded[c] = !ui.expanded[c]; render(); return; }
  }

  function init() {
    const view = document.getElementById("view-ranking");
    if (!view) return;
    view.addEventListener("click", onClick);
    // Opening Player Ranking from the main navbar defaults back to Batting.
    const tabs = document.getElementById("tabs");
    if (tabs) tabs.addEventListener("click", e => {
      if (e.target.closest('[data-tab="ranking"]')) { ui.cat = "batting"; render(); }
    });
    // Re-draw whenever the engine finishes (re)computing.
    const eng = engine();
    if (eng) eng.onChange(render);
    render();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
