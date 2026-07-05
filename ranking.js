/* ============================================================
   HCCL Player Ranking - boards

   Renders into #view-ranking: three boards - Batting, Bowling,
   All-Rounder - with columns Pos / Player Name / Team / Rating.

   Batting is COMPUTED live by the ranking engine from the bundled
   stats sheet: ranking-data.js (raw CSV) -> ranking-engine.js
   (window.HCCLRanking) -> rows here. Bowling still uses the
   hardcoded RANKINGS.bowling array (its engine is coming next);
   All-Rounder has no data yet and shows the "Coming Soon..."
   placeholder. Top 10 visible, expandable to the full list.

   Team icons: if the auction app has a team whose name contains the
   ranking team's keyword (e.g. "Lords" → "INVINCIBLE LORDS"), its
   uploaded logo is shown; otherwise a colored initial badge is used.

   Future: a moderator "Import stats CSV" upload will replace the
   bundled CSV source and recompute every board - the render path
   below already consumes computed rows, so only the data source
   changes.
   ============================================================ */
(function () {
  "use strict";

  const TOP_N = 10; // rows visible before expanding

  /* --------------------- computed batting rows --------------------- */
  // Built once from the bundled CSV via the engine; cached because the
  // result is independent of when auction team logos finish syncing.
  let battingCache;
  function battingRows() {
    if (battingCache !== undefined) return battingCache;
    battingCache = null;
    try {
      const R = window.HCCLRanking;
      const csv = window.HCCL_STATS_CSV;
      if (R && typeof R.battingFromCsv === "function" && csv) {
        const rows = R.battingFromCsv(csv).rows;
        // Map engine rows to the { pos, name, team, rating } shape the
        // table renderer expects (extra fields are harmless).
        battingCache = rows.map(r => ({ pos: r.pos, name: r.name, team: r.team, rating: r.rating }));
      }
    } catch (e) { console.error("batting ranking compute failed:", e); battingCache = null; }
    return battingCache;
  }

  // Rows for a board: batting is computed, the rest are hardcoded below.
  function rowsFor(key) {
    return key === "batting" ? battingRows() : RANKINGS[key];
  }

  /* ------------------ hardcoded rankings (interim) ------------------ */
  // { pos, name, team, rating } - pos is explicit so ties keep the
  // official numbering (e.g. two players at 24, then 26).
  const RANKINGS = {
    bowling: [
      { pos: 1,  name: "Udara",    team: "Tearz",   rating: 869 },
      { pos: 2,  name: "Chathuka", team: "Tearz",   rating: 787 },
      { pos: 3,  name: "Sasindu",  team: "Matrix",  rating: 785 },
      { pos: 4,  name: "Wenura",   team: "Lords",   rating: 709 },
      { pos: 5,  name: "Yasitha",  team: "Titans",  rating: 707 },
      { pos: 6,  name: "Kalana",   team: "Lords",   rating: 668 },
      { pos: 7,  name: "Kaushila", team: "Reapers", rating: 656 },
      { pos: 8,  name: "Rasindu",  team: "Gamers",  rating: 639 },
      { pos: 9,  name: "Kavishka", team: "Gamers",  rating: 636 },
      { pos: 10, name: "Yathish",  team: "Titans",  rating: 607 },
      { pos: 11, name: "Umesh",    team: "Reapers", rating: 568 },
      { pos: 12, name: "Nehan",    team: "Aura",    rating: 564 },
      { pos: 13, name: "Kasun",    team: "Aura",    rating: 564 },
      { pos: 14, name: "Sasiru",   team: "Titans",  rating: 561 },
      { pos: 15, name: "Pabeesha", team: "Lords",   rating: 549 },
      { pos: 16, name: "Chamindu", team: "Dragons", rating: 530 },
      { pos: 17, name: "Pasindu",  team: "Matrix",  rating: 509 },
      { pos: 18, name: "Sameera",  team: "Gamers",  rating: 503 },
      { pos: 19, name: "Shenal",   team: "Aura",    rating: 492 },
      { pos: 20, name: "Kanishka", team: "Reapers", rating: 489 },
    ],
    allrounder: null, // no data yet - shows the Coming Soon placeholder
  };

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

  function posCell(pos) {
    const medal = pos === 1 ? "🥇" : pos === 2 ? "🥈" : pos === 3 ? "🥉" : "";
    return medal || pos;
  }

  /* --------------------------- team icons --------------------------- */
  // Distinct fallback colors, deterministic per team name.
  const TEAM_COLORS = ["#e10600", "#f5b301", "#22c55e", "#3b82f6", "#a855f7", "#ec4899", "#14b8a6", "#f97316"];
  function teamColor(team) {
    let h = 0;
    for (let i = 0; i < team.length; i++) h = (h * 31 + team.charCodeAt(i)) | 0;
    return TEAM_COLORS[Math.abs(h) % TEAM_COLORS.length];
  }
  // Auction team logo if one matches (auction `state` is a top-level
  // binding in app.js - same global scope, may not be loaded/synced yet).
  function teamLogo(team) {
    try {
      if (typeof state === "undefined" || !state || !Array.isArray(state.teams)) return "";
      const kw = team.toLowerCase();
      const t = state.teams.find(x => (x.name || "").toLowerCase().includes(kw));
      return (t && t.logo) || "";
    } catch (e) { return ""; }
  }
  function teamIcon(team) {
    const logo = teamLogo(team);
    return logo
      ? `<span class="team-ico" title="${esc(team)}" style="background-image:url('${logo}')"></span>`
      : `<span class="team-ico" title="${esc(team)}" style="background:${teamColor(team)}">${esc(team[0] || "?")}</span>`;
  }

  /* ------------------------- board rendering ------------------------ */
  function tableFor(cat) {
    const rows = rowsFor(cat.key);

    if (!rows || !rows.length) {
      return `
        <div class="rank-card">
          <table class="rank-table">
            <thead>
              <tr><th class="rk-pos">Pos</th><th class="rk-name">Player Name</th><th class="rk-team">Team</th><th class="rk-rating">Rating</th></tr>
            </thead>
            <tbody>
              <tr><td colspan="4" class="rank-empty">
                <span class="rank-soon">Coming Soon...</span>
                Till that try to improve your stats 💪
              </td></tr>
            </tbody>
          </table>
        </div>`;
    }

    const expanded = !!ui.expanded[cat.key];
    const shown = expanded ? rows : rows.slice(0, TOP_N);
    const hasMore = rows.length > TOP_N;

    const body = shown.map(r => `
      <tr>
        <td class="rk-pos">${posCell(r.pos)}</td>
        <td class="rk-name">${esc(r.name)}</td>
        <td class="rk-team">${teamIcon(r.team)}</td>
        <td class="rk-rating">${esc(r.rating)}</td>
      </tr>`).join("");

    const expander = hasMore ? `
      <button class="rank-expand" type="button" data-rank-expand="${cat.key}" aria-expanded="${expanded}">
        <span>${expanded ? `Show top ${TOP_N}` : `Show all ${rows.length}`}</span>
        <span class="rank-chevron" aria-hidden="true">▾</span>
      </button>` : "";

    return `
      <div class="rank-card">
        <table class="rank-table">
          <thead>
            <tr><th class="rk-pos">Pos</th><th class="rk-name">Player Name</th><th class="rk-team">Team</th><th class="rk-rating">Rating</th></tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
        ${expander}
      </div>`;
  }

  function render() {
    const view = document.getElementById("view-ranking");
    if (!view) return;
    view.innerHTML = `
      <div class="view-head"><h2>PLAYER RANKING</h2></div>
      <div class="rank-sections">
        ${CATS.map(c => `
          <section class="rank-section">
            <h3 class="rank-sec-title">${c.label}</h3>
            ${tableFor(c)}
          </section>`).join("")}
      </div>`;
  }

  function onClick(e) {
    const ex = e.target.closest("[data-rank-expand]");
    if (ex) { const c = ex.getAttribute("data-rank-expand"); ui.expanded[c] = !ui.expanded[c]; render(); }
  }

  function init() {
    // The old ranking engine stored data on this device - tidy it up.
    try {
      ["hccl_ranking_history_v1", "hccl_ranking_latest_v1", "hccl_ranking_data_v2", "hccl_ranking_latest_v2"]
        .forEach(k => localStorage.removeItem(k));
    } catch (e) {}
    const view = document.getElementById("view-ranking");
    if (!view) return;
    view.addEventListener("click", onClick);
    // Re-render when the tab is opened so team icons pick up auction
    // logos once the cloud sync has delivered them.
    const tabs = document.getElementById("tabs");
    if (tabs) tabs.addEventListener("click", e => { if (e.target.closest('[data-tab="ranking"]')) render(); });
    render();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
