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

   Moderators/admins get an "Import stats CSV" button that uploads a
   new stats sheet to Firestore (ranking/stats.csv). Every signed-in
   device recomputes all three boards from that CSV, so a single import
   refreshes batting, bowling and all-rounder for everyone. The bundled
   CSV is the fallback when no import exists yet.
   ============================================================ */
(function () {
  "use strict";

  const TOP_N = 10; // rows visible before expanding

  /* ---------------------- computed rows (all boards) --------------- */
  // Every board is computed locally by the engine from a stats CSV.
  // Source of truth: an editor-imported CSV stored in Firestore
  // (ranking/stats.csv); if there is none, the bundled ranking-data.js CSV.
  // Storing the raw CSV (not the computed boards) means every device
  // recomputes with the current engine, so batting/bowling/all-rounder
  // always stay consistent with the ratings logic. Map key -> the
  // engine's "<board>FromCsv" fn name.
  const ENGINE_FN = {
    batting: "battingFromCsv",
    bowling: "bowlingFromCsv",
    allrounder: "allRounderFromCsv",
  };
  const boardCache = {};
  let activeCsv = null;   // cloud-imported CSV; null -> bundled fallback
  let lastImport = null;  // { by } for the "last updated" note
  let prevPositions = null; // per board { nameKey: pos } from the PREVIOUS sheet
  function currentCsv() { return activeCsv || window.HCCL_STATS_CSV || ""; }
  function resetBoards() { for (const k in boardCache) delete boardCache[k]; }

  function computeBoard(key) {
    if (key in boardCache) return boardCache[key];
    let out = null;
    try {
      const R = window.HCCLRanking;
      const csv = currentCsv();
      const fn = ENGINE_FN[key];
      if (R && fn && typeof R[fn] === "function" && csv) {
        // Keep only the { pos, name, team, rating } the table needs.
        out = R[fn](csv).rows.map(r => ({ pos: r.pos, name: r.name, team: r.team, rating: r.rating }));
      }
    } catch (e) { console.error(key + " ranking compute failed:", e); out = null; }
    boardCache[key] = out;
    return out;
  }
  function rowsFor(key) { return computeBoard(key); }

  // Player key for matching the same player across sheets.
  const keyOf = s => String(s == null ? "" : s).trim().toLowerCase();
  // { board: { nameKey: pos } } computed from a CSV, for rank-movement diffs.
  function positionsFromCsv(csv) {
    const out = {};
    Object.keys(ENGINE_FN).forEach(key => {
      const map = {};
      try {
        const R = window.HCCLRanking, fn = ENGINE_FN[key];
        if (R && typeof R[fn] === "function" && csv) R[fn](csv).rows.forEach(r => { map[keyOf(r.name)] = r.pos; });
      } catch (e) {}
      out[key] = map;
    });
    return out;
  }

  /* ------------- Firestore: shared imported stats CSV -------------- */
  // Everyone signed in reads ranking/stats; moderators/admins upload a new
  // CSV via the Import button. Firestore rules (ranking/**: write if editor)
  // enforce who can publish. The bundled CSV is the fallback when no import
  // exists yet.
  let statsSyncStarted = false;
  function startStatsSync() {
    const H = window.HCCL;
    if (statsSyncStarted || !H || !H.configured || !H.user || !H.db || !H.fs) return;
    const fs = H.fs;
    if (!fs.doc || !fs.onSnapshot) return;
    statsSyncStarted = true;
    const ref = fs.doc(H.db, "ranking", "stats");
    fs.onSnapshot(ref, snap => {
      const data = snap.exists() ? snap.data() : null;
      const csv = data && typeof data.csv === "string" && data.csv.trim() ? data.csv : null;
      activeCsv = csv;                  // null -> bundled fallback
      lastImport = data ? { by: data.updatedBy || "" } : null;
      prevPositions = (data && data.prev) || null; // positions before this import
      resetBoards();
      render();
    }, err => console.error("ranking stats snapshot error:", err));
  }

  function notify(msg, kind) {
    if (typeof window.toast === "function") window.toast(msg, kind);
    else console.log("[ranking]", msg);
  }

  // Editor-only: validate an uploaded CSV, then publish it to Firestore so
  // every signed-in device updates (or apply locally when there is no cloud).
  async function importStatsCsv(file) {
    if (!file) return;
    const H = window.HCCL, R = window.HCCLRanking;
    let text = "";
    try { text = await file.text(); } catch (e) { notify("Couldn't read that file.", "bad"); return; }
    let players = [];
    try { players = R && R.parsePlayers ? R.parsePlayers(text) : []; } catch (e) { players = []; }
    if (!players.length) { notify("No players found - use the HCCL Statistics.csv format.", "bad"); return; }

    // Cloud mode: publish so every signed-in device updates.
    if (H && H.configured && H.db && H.fs && H.fs.setDoc && H.canEdit && H.canEdit()) {
      try {
        const ref = H.fs.doc(H.db, "ranking", "stats");
        // Snapshot the outgoing sheet's positions so the new one can show movement.
        const prev = positionsFromCsv(currentCsv());
        await H.fs.setDoc(ref, {
          csv: text,
          prev,
          updatedAt: H.fs.serverTimestamp ? H.fs.serverTimestamp() : Date.now(),
          updatedBy: (H.user && (H.user.displayName || H.user.email)) || "",
        });
        notify(`Stats imported - ${players.length} players. Rankings updated for everyone.`, "good");
        // onSnapshot re-renders every device (including this one).
      } catch (e) {
        console.error("stats upload failed:", e);
        notify("Upload failed - need moderator/admin + published rules.", "bad");
      }
      return;
    }
    // Signed-in but not an editor: not allowed (the button is hidden for
    // viewers; this is a belt-and-braces guard - rules also block the write).
    if (H && H.configured) { notify("Only moderators/admins can import stats.", "bad"); return; }
    // Offline / open mode (no cloud): apply on this device only.
    prevPositions = positionsFromCsv(currentCsv());
    activeCsv = text; resetBoards(); render();
    notify(`Stats imported - ${players.length} players (this device only).`, "good");
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

  /* ------------------- rank-movement indicator --------------------- */
  // Shown before a player's name. Compares the current position with the
  // previous sheet's (prevPositions, set at import). Climbed = green up arrow +
  // places, dropped = red down arrow + places; otherwise a gray "=" when the
  // player is tied on rating with a neighbour; nothing when simply unchanged.
  function moveIndicator(boardKey, rows, i) {
    const r = rows[i];
    const prev = prevPositions && prevPositions[boardKey];
    const prevPos = prev ? prev[keyOf(r.name)] : undefined;
    if (prevPos != null) {
      const delta = prevPos - r.pos;
      if (delta > 0) return `<span class="rank-move up" title="Up ${delta}">▲${delta}</span>`;
      if (delta < 0) return `<span class="rank-move down" title="Down ${-delta}">▼${-delta}</span>`;
    }
    const tie = (rows[i - 1] && rows[i - 1].rating === r.rating) ||
                (rows[i + 1] && rows[i + 1].rating === r.rating);
    return tie ? `<span class="rank-move same" title="Tied rating">=</span>` : "";
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

    const body = shown.map((r, i) => `
      <tr>
        <td class="rk-pos">${posCell(r.pos)}</td>
        <td class="rk-name">${moveIndicator(cat.key, rows, i)}${esc(r.name)}</td>
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
    const updated = lastImport && lastImport.by
      ? `<span class="rank-updated">Stats updated by ${esc(lastImport.by)}</span>` : "";
    view.innerHTML = `
      <div class="view-head">
        <h2>PLAYER RANKING</h2>
        <div class="rank-tools">
          ${updated}
          <label class="btn btn-yellow file-btn rank-import" title="Upload the latest HCCL stats CSV to refresh all rankings">
            <span>⬆ Import stats CSV</span>
            <input type="file" id="rankImportFile" accept=".csv,text/csv" hidden />
          </label>
        </div>
      </div>
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
    // Editor picks a CSV file -> validate + publish/apply.
    view.addEventListener("change", e => {
      const inp = e.target.closest("#rankImportFile");
      if (inp && inp.files && inp.files[0]) { importStatsCsv(inp.files[0]); inp.value = ""; }
    });
    // Re-render when the tab is opened so team icons pick up auction
    // logos once the cloud sync has delivered them.
    const tabs = document.getElementById("tabs");
    if (tabs) tabs.addEventListener("click", e => { if (e.target.closest('[data-tab="ranking"]')) render(); });
    // Subscribe to the shared imported CSV, and re-render when the signed-in
    // role changes so the editor-only Import button shows/hides correctly.
    if (window.HCCL && typeof window.HCCL.onChange === "function") {
      window.HCCL.onChange(() => { startStatsSync(); render(); });
    }
    render();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
