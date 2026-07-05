/* ============================================================
   HCCL Player Ranking - boards

   Renders into #view-ranking: three boards - Batting, Bowling,
   All-Rounder - with columns Pos / Player Name / Team / Rating.

   All three boards are COMPUTED live by the ranking engine from the
   bundled stats sheet: ranking-data.js (raw CSV) -> ranking-engine.js
   (window.HCCLRanking) -> rows here. All-Rounder is the geometric mean
   sqrt(batting * bowling) for players ranked in both boards.
   Top 10 visible, expandable to the full list.

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

  /* ---------------------- computed rows (all boards) --------------- */
  // Every board is computed from the bundled CSV via the engine, and
  // cached because the result is independent of when auction team logos
  // finish syncing. Map key -> the engine's "<board>FromCsv" fn name.
  const ENGINE_FN = {
    batting: "battingFromCsv",
    bowling: "bowlingFromCsv",
    allrounder: "allRounderFromCsv",
  };
  const boardCache = {};
  // Boards read from Firestore (ranking/league). When present these win over
  // the local compute so every signed-in device shows the same published data.
  let cloudBoards = null; // { batting:[], bowling:[], allrounder:[] } | null

  // Local compute from the bundled CSV (offline fallback + the seed source).
  function computeBoard(key) {
    if (key in boardCache) return boardCache[key];
    let out = null;
    try {
      const R = window.HCCLRanking;
      const csv = window.HCCL_STATS_CSV;
      const fn = ENGINE_FN[key];
      if (R && fn && typeof R[fn] === "function" && csv) {
        // Keep only the { pos, name, team, rating } the table needs.
        out = R[fn](csv).rows.map(r => ({ pos: r.pos, name: r.name, team: r.team, rating: r.rating }));
      }
    } catch (e) { console.error(key + " ranking compute failed:", e); out = null; }
    boardCache[key] = out;
    return out;
  }
  function rowsFor(key) {
    if (cloudBoards && Array.isArray(cloudBoards[key])) return cloudBoards[key];
    return computeBoard(key);
  }

  /* ---------------- Firestore: read cloud boards + editor seed --------------- */
  // "Seed once, read-only": everyone reads ranking/league; an editor whose
  // bundled data is newer than the stored doc (re)publishes it. Viewers never
  // write (Firestore rules enforce it) and fall back to the local compute.
  let rankingSyncStarted = false;
  function startRankingSync() {
    const H = window.HCCL;
    if (rankingSyncStarted || !H || !H.configured || !H.user || !H.db || !H.fs) return;
    const fs = H.fs;
    if (!fs.doc || !fs.onSnapshot) return;
    rankingSyncStarted = true;
    const ref = fs.doc(H.db, "ranking", "league");
    fs.onSnapshot(ref, snap => {
      const data = snap.exists() ? snap.data() : null;
      const version = window.HCCL_STATS_VERSION || "";
      const fresh = !!(data && data.version === version);
      if (fresh) {
        cloudBoards = {
          batting: data.batting || [], bowling: data.bowling || [], allrounder: data.allrounder || [],
        };
        render();
      }
      // Missing or stale -> an editor publishes the current bundled boards.
      if (!fresh && H.canEdit && H.canEdit() && fs.setDoc) {
        const boards = {};
        CATS.forEach(c => { boards[c.key] = computeBoard(c.key) || []; });
        if (boards.batting && boards.batting.length) {
          fs.setDoc(ref, {
            version,
            updatedAt: fs.serverTimestamp ? fs.serverTimestamp() : Date.now(),
            batting: boards.batting, bowling: boards.bowling, allrounder: boards.allrounder,
          }).catch(err => console.error("ranking cloud seed failed:", err));
        }
      }
    }, err => console.error("ranking snapshot error:", err));
  }

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
    // Read cloud boards (and seed them, if an editor) once signed in.
    if (window.HCCL && typeof window.HCCL.onChange === "function") {
      window.HCCL.onChange(() => startRankingSync());
    }
    render();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
