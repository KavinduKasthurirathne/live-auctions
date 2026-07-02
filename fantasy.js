/* ============================================================
   HCCL Fantasy League  (self-contained - does not touch the auction)
   Stored separately in localStorage under "hccl_fantasy_v1".
   Reads the auction key only for the optional "Import" button.
   ============================================================ */
(function () {
  "use strict";

  const FKEY = "hccl_fantasy_v1";
  const AKEY = "hccl_auction_v1";

  /* ---------------- state ---------------- */
  function defaultFantasy() {
    return { teams: [], players: [], contestants: [], days: [] };
  }
  function normalizeF(s) {
    s = s || {};
    s.teams = Array.isArray(s.teams) ? s.teams : [];
    s.players = Array.isArray(s.players) ? s.players : [];
    s.contestants = Array.isArray(s.contestants) ? s.contestants : [];
    s.days = (Array.isArray(s.days) ? s.days : []).map(d => ({
      id: d.id, date: d.date || "", label: d.label || "",
      teamIds: Array.isArray(d.teamIds) ? d.teamIds : [],
      performance: d.performance || {},
      entries: (Array.isArray(d.entries) ? d.entries : []).map(e => ({
        id: e.id, contestantId: e.contestantId,
        playerIds: Array.isArray(e.playerIds) ? e.playerIds : [],
        captainId: e.captainId || null, viceCaptainId: e.viceCaptainId || null,
      })),
      hasResults: !!d.hasResults,
    }));
    return s;
  }
  function loadF() {
    try { const r = localStorage.getItem(FKEY); if (r) return normalizeF(JSON.parse(r)); } catch (e) {}
    return defaultFantasy();
  }
  function saveF() {
    // In cloud mode Firestore is the source of truth; leave the local backup
    // (FKEY) untouched so a one-time "upload to cloud" can still recover it.
    if (usingFirestore) { if (canEditApp()) syncDiff(); return; }
    try { localStorage.setItem(FKEY, JSON.stringify(F)); } catch (e) { ftoast("Storage full - export a backup", "bad"); }
  }

  let F = loadF();
  const UI = { sub: "matchday", dayId: null, editEntryId: null, editTeamId: null, editPlayerId: null };

  /* ============================================================
     FIRESTORE REAL-TIME SYNC (Phase C)
     When Firebase is configured, fantasy data lives in Firestore under
     fantasy/league/{teams,players,contestants,days}/{id}. onSnapshot mirrors
     it into F; local edits (saveF) are pushed as a minimal diff. With no
     Firebase (or if it can't be reached) we stay on localStorage as before.
     ============================================================ */
  const FS_COLLS = ["teams", "players", "contestants", "days"];
  let usingFirestore = false;
  let fsReady = false;                 // true once every collection has loaded at least once
  const fsLoaded = new Set();
  const fsMirror = { teams: [], players: [], contestants: [], days: [] }; // last known server state
  const fsUnsubs = [];
  let pendingRender = false;           // defer re-render while an editor is typing
  let fsSyncing = false, fsSyncAgain = false;
  let fsFellBack = false, fsFellBackMsg = "";  // cloud unreachable -> local-only

  const fsDb = () => window.HCCL && window.HCCL.db;
  const fsApi = () => window.HCCL && window.HCCL.fs;
  function fsRef(coll, id) { return fsApi().doc(fsDb(), "fantasy", "league", coll, id); }
  function stripId(o) { const c = Object.assign({}, o); delete c.id; return c; }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  function normItem(coll, id, d) {
    if (coll === "days") {
      return {
        id, date: d.date || "", label: d.label || "",
        teamIds: Array.isArray(d.teamIds) ? d.teamIds : [],
        performance: d.performance || {},
        entries: (Array.isArray(d.entries) ? d.entries : []).map(e => ({
          id: e.id, contestantId: e.contestantId,
          playerIds: Array.isArray(e.playerIds) ? e.playerIds : [],
          captainId: e.captainId || null, viceCaptainId: e.viceCaptainId || null,
        })),
        hasResults: !!d.hasResults,
      };
    }
    if (coll === "players") return { id, name: d.name || "", teamId: d.teamId || "" };
    return { id, name: d.name || "" }; // teams, contestants
  }

  function fallbackToLocal(msg) {
    if (fsFellBack || fsReady) return;     // already loaded fine, or already fell back
    fsFellBack = true; fsFellBackMsg = msg;
    fsUnsubs.splice(0).forEach(u => { try { u(); } catch (e) {} });
    usingFirestore = false;
    F = loadF();
    ftoast(msg, "bad");
    renderFantasy();
  }
  function startFantasySync() {
    const api = fsApi(), db = fsDb();
    FS_COLLS.forEach(coll => {
      const unsub = api.onSnapshot(api.collection(db, "fantasy", "league", coll),
        snap => {
          const items = snap.docs.map(docSnap => normItem(coll, docSnap.id, docSnap.data()));
          fsMirror[coll] = clone(items);
          F[coll] = items;
          fsLoaded.add(coll);
          if (!fsReady && fsLoaded.size === FS_COLLS.length) fsReady = true;
          onRemoteChange();
        },
        err => {
          console.error("fantasy snapshot error:", coll, err);
          const code = err && err.code;
          fallbackToLocal(
            code === "permission-denied" ? "Cloud blocked: publish the latest Firestore rules"
              : code === "not-found" ? "Firestore database not created yet — create it in the Firebase console"
              : "Live sync unavailable — this device only");
        }
      );
      fsUnsubs.push(unsub);
    });
    // If Firestore just hangs (blocked/offline, no error fired), don't sit on "Loading…".
    setTimeout(() => fallbackToLocal("Live sync unavailable — this device only"), 6000);
  }

  function onRemoteChange() {
    // Don't wipe an editor's in-progress typing; defer the re-render until blur.
    const ae = document.activeElement, root = fanEl();
    if (ae && root && root.contains(ae) && ["INPUT", "SELECT", "TEXTAREA"].includes(ae.tagName)) {
      pendingRender = true; return;
    }
    renderFantasy();
  }

  async function syncDiff() {
    if (!fsReady) return;            // never push until we have the server baseline
    if (fsSyncing) { fsSyncAgain = true; return; }
    fsSyncing = true;
    try {
      const api = fsApi(), db = fsDb();
      const ops = [];
      FS_COLLS.forEach(coll => {
        const cur = F[coll] || [], prev = fsMirror[coll] || [];
        const prevMap = new Map(prev.map(x => [x.id, x]));
        const curIds = new Set(cur.map(x => x.id));
        cur.forEach(item => {
          const before = prevMap.get(item.id);
          if (!before || JSON.stringify(stripId(before)) !== JSON.stringify(stripId(item)))
            ops.push({ t: "set", ref: fsRef(coll, item.id), data: stripId(item) });
        });
        prev.forEach(item => { if (!curIds.has(item.id)) ops.push({ t: "del", ref: fsRef(coll, item.id) }); });
      });
      for (let i = 0; i < ops.length; i += 450) {        // Firestore batch limit is 500
        const batch = api.writeBatch(db);
        ops.slice(i, i + 450).forEach(op => op.t === "set" ? batch.set(op.ref, op.data) : batch.delete(op.ref));
        await batch.commit();
      }
      FS_COLLS.forEach(coll => { fsMirror[coll] = clone(F[coll] || []); }); // advance baseline
    } catch (e) {
      console.error("fantasy sync failed:", e);
      ftoast("Couldn't save to the cloud", "bad");
      FS_COLLS.forEach(coll => { F[coll] = clone(fsMirror[coll] || []); }); // revert to server state
      renderFantasy();
    } finally {
      fsSyncing = false;
      if (fsSyncAgain) { fsSyncAgain = false; syncDiff(); }
    }
  }

  /* ---------------- helpers ---------------- */
  const fid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const fanEl = () => document.getElementById("view-fantasy");
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  const fTeam = id => F.teams.find(t => t.id === id);
  const fPlayer = id => F.players.find(p => p.id === id);
  const fContestant = id => F.contestants.find(c => c.id === id);
  const fDay = id => F.days.find(d => d.id === id);
  const pname = id => { const p = fPlayer(id); return p ? p.name : ""; };
  const teamName = id => { const t = fTeam(id); return t ? t.name : "-"; };
  function fmtPts(n) { return String(Math.round((Number(n) || 0) * 100) / 100); }
  function today() { return new Date().toISOString().slice(0, 10); }
  function dayLabel(d) {
    if (!d) return "";
    const dt = new Date(d.date + "T00:00:00");
    const s = isNaN(dt.getTime()) ? (d.date || "Day") : dt.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
    return s + (d.label ? " · " + d.label : "");
  }
  function medal(i) { return i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : String(i + 1); }

  let ftoastTimer;
  function ftoast(msg, kind = "") {
    const t = document.getElementById("toast"); if (!t) return;
    t.textContent = msg; t.className = "toast " + kind;
    clearTimeout(ftoastTimer); ftoastTimer = setTimeout(() => t.classList.add("hidden"), 2400);
  }

  /* ---------------- scoring ---------------- */
  function dayPool(day) { return F.players.filter(p => day.teamIds.includes(p.teamId)); }
  function playerDayPoints(day, playerId) {
    const perf = day.performance && day.performance[playerId];
    if (!perf) return 0;
    return (Number(perf.runs) || 0) + (Number(perf.wickets) || 0) * 10;
  }
  function entryPoints(day, entry) {
    return entry.playerIds.reduce((sum, pid) => {
      let pts = playerDayPoints(day, pid);
      if (pid === entry.captainId) pts *= 2;
      else if (pid === entry.viceCaptainId) pts *= 1.5;
      return sum + pts;
    }, 0);
  }
  function dayStandings(day) {
    return day.entries
      .map(e => ({ entry: e, contestant: fContestant(e.contestantId), points: entryPoints(day, e) }))
      .sort((a, b) => b.points - a.points);
  }
  function contestantStats() {
    return F.contestants.map(c => {
      let total = 0, n = 0;
      F.days.forEach(d => {
        if (!d.hasResults) return;
        const e = d.entries.find(x => x.contestantId === c.id);
        if (e) { total += entryPoints(d, e); n++; }
      });
      return { contestant: c, total, days: n, avg: n ? total / n : 0 };
    }).sort((a, b) => b.total - a.total || b.avg - a.avg);
  }
  function playerStats() {
    return F.players.map(p => {
      let total = 0, n = 0;
      F.days.forEach(d => {
        if (!d.hasResults || !d.teamIds.includes(p.teamId)) return;
        total += playerDayPoints(d, p.id); n++;
      });
      return { player: p, total, days: n, avg: n ? total / n : 0 };
    }).sort((a, b) => b.total - a.total || b.avg - a.avg);
  }
  function currentDay() {
    if (UI.dayId) { const d = fDay(UI.dayId); if (d) return d; }
    const d = F.days[0]; UI.dayId = d ? d.id : null; return d || null;
  }

  /* ============================================================
     RENDER
     ============================================================ */
  function canEditApp() {
    const H = window.HCCL;
    return !H || !H.configured || H.canEdit();
  }
  function renderFantasy() {
    const v = fanEl(); if (!v) return;
    if (!canEditApp() && UI.sub !== "leaderboard") UI.sub = "leaderboard";
    v.innerHTML = `
      <div class="view-head">
        <h2>FANTASY LEAGUE</h2>
        <div class="fan-subnav">
          ${subBtn("matchday", "📅 Match Day")}
          ${subBtn("leaderboard", "🏆 Leaderboards")}
          ${subBtn("manage", "⚙️ Manage")}
        </div>
      </div>
      ${fsFellBack ? `<div class="card" style="border-color:var(--red)"><p class="hint" style="margin:0">⚠ ${esc(fsFellBackMsg)}. Showing this device only — changes won't sync and the cloud-upload button is hidden. Fix the cause (publish rules / disable ad-blocker) and reload.</p></div>` : ""}
      <div id="fan-body"></div>`;
    renderFanBody();
  }
  function subBtn(key, label) {
    return `<button class="fan-tab ${UI.sub === key ? "active" : ""}" data-fan-sub="${key}">${label}</button>`;
  }
  function renderFanBody() {
    const body = document.getElementById("fan-body"); if (!body) return;
    if (usingFirestore && !fsReady) { body.innerHTML = `<div class="card"><p class="hint">Loading league data…</p></div>`; return; }
    // Viewers only get the read-only Leaderboards (Match Day & Manage are editing surfaces).
    if (!canEditApp() && UI.sub !== "leaderboard") UI.sub = "leaderboard";
    if (UI.sub === "leaderboard") body.innerHTML = renderLeaderboards();
    else if (UI.sub === "manage") body.innerHTML = renderManage();
    else body.innerHTML = renderMatchDay();
    if (UI.sub === "matchday") refreshEntryPickUI();
  }

  /* ---------- match day ---------- */
  function renderMatchDay() {
    if (!F.teams.length) {
      return `<div class="card"><h3>Get started</h3>
        <p class="hint">Add your tournament teams &amp; players first - open <b>⚙️ Manage</b>, or import them from the auction.</p>
        <div class="form-row"><button class="btn btn-yellow" data-fan-sub="manage">Open Manage</button></div></div>`;
    }
    const days = F.days;
    let html = `<div class="card">
      <div class="form-row" style="align-items:flex-end">
        <label style="flex:1 1 180px">Match day
          <select id="fanDaySelect">${days.length ? days.map(d => `<option value="${d.id}" ${d.id === UI.dayId ? "selected" : ""}>${esc(dayLabel(d))}</option>`).join("") : `<option value="">No days yet</option>`}</select>
        </label>
        <label>New day<input type="date" id="fanNewDate" value="${today()}"/></label>
        <button class="btn btn-yellow" data-new-day>+ New day</button>
      </div></div>`;

    const day = currentDay();
    if (!day) return html + `<p class="hint">Create a match day to begin.</p>`;

    html += `<div class="card">
      <h3>Teams playing - ${esc(dayLabel(day))}</h3>
      <p class="hint">Tick the teams in action today; their players form the selectable pool.</p>
      <div class="fan-team-toggles">
        ${F.teams.map(t => `<label class="fan-chip ${day.teamIds.includes(t.id) ? "on" : ""}"><input type="checkbox" data-toggle-team="${t.id}" ${day.teamIds.includes(t.id) ? "checked" : ""}/>${esc(t.name)}</label>`).join("")}
      </div>
      <div class="form-row" style="margin-top:10px"><button class="btn btn-danger" data-del-day="${day.id}">Delete this day</button></div>
    </div>`;

    html += renderEntrySection(day);
    html += renderResultsSection(day);
    html += renderDayStandings(day);
    return html;
  }

  function renderEntrySection(day) {
    const pool = dayPool(day);
    let html = `<div class="card"><h3>Fantasy Entries</h3>`;
    if (!pool.length) return html + `<p class="hint">Select the teams playing today to build the player pool.</p></div>`;

    const edit = UI.editEntryId ? day.entries.find(e => e.id === UI.editEntryId) : null;
    const picked = new Set(edit ? edit.playerIds : []);

    html += `<label>Contestant name
        <input id="fanContestant" list="fanCList" placeholder="e.g. Yasitha" value="${edit && fContestant(edit.contestantId) ? esc(fContestant(edit.contestantId).name) : ""}"/>
      </label>
      <datalist id="fanCList">${F.contestants.map(c => `<option value="${esc(c.name)}"></option>`).join("")}</datalist>
      <div class="fan-pool">`;
    day.teamIds.forEach(tid => {
      const ps = F.players.filter(p => p.teamId === tid);
      if (!ps.length) return;
      html += `<div class="fan-pool-team"><div class="fan-pool-team-name">${esc(teamName(tid))}</div>`;
      ps.forEach(p => {
        html += `<label class="fan-pick"><input type="checkbox" data-pick="${p.id}" ${picked.has(p.id) ? "checked" : ""}/>${esc(p.name)}</label>`;
      });
      html += `</div>`;
    });
    html += `</div>
      <div id="fanPickCount" class="fan-count">0/6 selected</div>
      <div class="form-row">
        <label>Captain (2×)<select id="fanC"></select></label>
        <label>Vice-Captain (1.5×)<select id="fanVC"></select></label>
      </div>
      <div class="form-row">
        <button class="btn btn-red" data-add-entry>${edit ? "Update team" : "Add team"}</button>
        ${edit ? `<button class="btn btn-dark" data-cancel-entry>Cancel</button>` : ""}
      </div>`;

    if (day.entries.length) {
      html += `<div class="fan-entries">`;
      day.entries.forEach(e => {
        const pts = entryPoints(day, e);
        html += `<div class="fan-entry">
          <div class="fan-entry-head"><b>${esc(fContestant(e.contestantId) ? fContestant(e.contestantId).name : "?")}</b>
            ${day.hasResults ? `<span class="fan-pts">${fmtPts(pts)} pts</span>` : `<span class="hint">pending results</span>`}
            <span class="fan-entry-actions"><button class="icon-btn" data-edit-entry="${e.id}" title="Edit">✎</button><button class="icon-btn del" data-del-entry="${e.id}" title="Delete">✕</button></span>
          </div>
          <div class="fan-entry-players">${e.playerIds.map(pid => playerChip(pid, e, day)).join("")}</div>
        </div>`;
      });
      html += `</div>`;
    }
    return html + `</div>`;
  }
  function playerChip(pid, e, day) {
    const tag = pid === e.captainId ? `<span class="cap">C</span>` : pid === e.viceCaptainId ? `<span class="vc">VC</span>` : "";
    let pts = "";
    if (day && day.hasResults) {
      let val = playerDayPoints(day, pid);
      if (pid === e.captainId) val *= 2;
      else if (pid === e.viceCaptainId) val *= 1.5;
      pts = `<span class="pchip-pts">${fmtPts(val)}</span>`;
    }
    return `<span class="fan-pchip">${esc(pname(pid))}${tag}${pts}</span>`;
  }

  function renderResultsSection(day) {
    const pool = dayPool(day);
    let html = `<div class="card"><h3>Match results ${day.hasResults ? `<span class="badge sold">saved</span>` : ""}</h3>`;
    if (!pool.length) return html + `<p class="hint">Select the teams playing to enter results.</p></div>`;
    html += `<p class="hint">Enter each player's runs &amp; wickets. Points = runs + wickets × 10.</p><div class="fan-results">`;
    day.teamIds.forEach(tid => {
      const ps = F.players.filter(p => p.teamId === tid);
      if (!ps.length) return;
      html += `<div class="fan-results-team"><div class="fan-pool-team-name">${esc(teamName(tid))}</div>`;
      ps.forEach(p => {
        const perf = (day.performance && day.performance[p.id]) || {};
        html += `<div class="fan-res-row">
          <span class="frr-name">${esc(p.name)}</span>
          <input type="number" min="0" inputmode="numeric" data-runs="${p.id}" value="${perf.runs != null ? perf.runs : ""}" placeholder="runs"/>
          <input type="number" min="0" inputmode="numeric" data-wkts="${p.id}" value="${perf.wickets != null ? perf.wickets : ""}" placeholder="wkts"/>
          <span class="frr-pts">${fmtPts(playerDayPoints(day, p.id))}</span>
        </div>`;
      });
      html += `</div>`;
    });
    html += `</div><div class="form-row"><button class="btn btn-yellow" data-save-results>Save results &amp; calculate</button></div></div>`;
    return html;
  }

  function renderDayStandings(day) {
    if (!day.entries.length) return "";
    if (!day.hasResults) return `<div class="card"><h3>Day Standings - ${esc(dayLabel(day))}</h3><p class="hint">Save match results to see points.</p></div>`;
    let html = `<div class="card"><div class="fan-card-head"><h3>Day Standings - ${esc(dayLabel(day))}</h3><button class="btn btn-dark fan-share-btn" data-share-day title="Download as image">📷 Share</button></div>`;
    html += `<table class="fan-table"><thead><tr><th>#</th><th>Contestant</th><th class="num">Points</th></tr></thead><tbody>`;
    dayStandings(day).forEach((row, i) => {
      html += `<tr><td>${medal(i)}</td><td>${esc(row.contestant ? row.contestant.name : "?")}</td><td class="num strong">${fmtPts(row.points)}</td></tr>`;
    });
    return html + `</tbody></table></div>`;
  }

  /* ---------- leaderboards ---------- */
  function renderLeaderboards() {
    const cs = contestantStats(), ps = playerStats();
    return `<div class="fan-board-grid">
      <div class="card"><div class="fan-card-head"><h3>🏆 Contestants</h3><button class="btn btn-dark fan-share-btn" data-share-board="contestant" title="Download as image">📷 Share</button></div>
        ${boardTable(cs.map(s => ({ name: s.contestant.name, avg: s.avg, days: s.days, total: s.total })), "Contestant", "contestant")}</div>
      <div class="card"><div class="fan-card-head"><h3>⭐ Player of the Season</h3><button class="btn btn-dark fan-share-btn" data-share-board="player" title="Download as image">📷 Share</button></div>
        ${boardTable(ps.map(s => ({ name: s.player.name, sub: teamName(s.player.teamId), avg: s.avg, days: s.days, total: s.total })), "Player", "player")}</div>
    </div>`;
  }
  function boardTable(rows, label, kind) {
    if (!rows.length) return `<p class="hint">No results yet. Add entries and save match results.</p>`;
    const head = kind === "player"
      ? `<th class="num" title="Matches played">Matches</th><th class="num" title="Total points">Total</th>`
      : `<th class="num" title="Total points">Total</th>`;
    const cells = r => kind === "player"
      ? `<td class="num">${r.days}</td><td class="num strong">${fmtPts(r.total)}</td>`
      : `<td class="num strong">${fmtPts(r.total)}</td>`;
    return `<table class="fan-table">
      <thead><tr><th>#</th><th>${label}</th>${head}</tr></thead>
      <tbody>${rows.map((r, i) => `<tr>
        <td>${medal(i)}</td>
        <td>${esc(r.name)}${r.sub ? `<span class="frr-sub">${esc(r.sub)}</span>` : ""}</td>
        ${cells(r)}</tr>`).join("")}</tbody></table>`;
  }

  /* ---------- share leaderboard as image ---------- */
  function shareRankBadge(i) {
    const base = "width:48px;height:48px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:'Heading Pro',sans-serif;font-weight:700;font-size:24px;flex:none;";
    const grad = i === 0 ? "linear-gradient(135deg,#ffe066,#f5b301)"
      : i === 1 ? "linear-gradient(135deg,#dcdce4,#9a9aa4)"
      : i === 2 ? "linear-gradient(135deg,#e0975a,#a05a1e)" : "";
    return grad
      ? `<div style="${base}color:#1a1300;background:${grad};">${i + 1}</div>`
      : `<div style="${base}color:#9b9ba3;background:#2a2a2e;">${i + 1}</div>`;
  }
  function shareDateStr() {
    return new Date().toLocaleDateString(undefined, { day: "2-digit", month: "long", year: "numeric" });
  }
  // The branded off-screen card shell shared by every share image: season title,
  // subtitle, date, divider, the row body, and the footer. `innerHtml` is the table.
  function buildShareShell(subTitle, dateStr, innerHtml) {
    const seasonEl = document.getElementById("seasonTitle");
    const seasonTitle = (seasonEl && seasonEl.textContent.trim()) || "HCCL";
    const card = document.createElement("div");
    // Lay out at the origin (NOT off-screen via a huge negative offset - the
    // node's own position is copied onto html-to-image's clone, so left:-99999px
    // pushes the content outside the captured SVG => an all-black image). Use
    // position:absolute (NOT fixed): a fixed node taller than the viewport gets
    // clipped to the screen height, cutting off the lower rows. Absolute lets the
    // node take its full content height so the entire table is captured. We tuck
    // it behind the app with z-index:-1; do NOT use opacity/visibility to hide it
    // - those get cloned too and would blank the capture.
    card.style.cssText = "position:absolute;left:0;top:0;z-index:-1;pointer-events:none;" +
      "width:1080px;box-sizing:border-box;padding:52px 48px;" +
      "background:#0a0a0b;color:#f6f6f7;font-family:'Inter',system-ui,sans-serif;";
    card.innerHTML = `
      <div style="text-align:center;">
        <div style="font-family:'Heading Pro',sans-serif;font-weight:700;font-size:56px;letter-spacing:1px;line-height:1;color:#ffcc00;">${esc(seasonTitle)} - Fantasy</div>
        <div style="font-size:23px;letter-spacing:4px;text-transform:uppercase;color:#f6f6f7;margin-top:14px;">${esc(subTitle)}</div>
        <div style="font-size:16px;color:#9b9ba3;margin-top:10px;">${esc(dateStr)}</div>
      </div>
      <div style="height:3px;border-radius:3px;background:linear-gradient(90deg,transparent,#e10600,#f5b301,transparent);margin:26px 0 30px;"></div>
      <div style="max-width:840px;margin:0 auto;">${innerHtml}</div>
      <div style="margin-top:30px;text-align:center;color:#5a5a62;font-size:15px;letter-spacing:3px;text-transform:uppercase;">
        HC Champions League
      </div>`;
    return card;
  }
  function buildShareCard(kind, stats) {
    const isPlayer = kind === "player";
    // Players board: top 10 only. Contestants board: everyone.
    const ranked = isPlayer ? stats.slice(0, 10) : stats;
    const rows = ranked.map((s, i) => isPlayer
      ? { i, name: s.player.name, sub: teamName(s.player.teamId), total: s.total, days: s.days, avg: s.avg }
      : { i, name: s.contestant.name, sub: "", total: s.total, days: s.days, avg: s.avg });
    const subTitle = isPlayer ? "Fantasy Player of the Season" : "Fantasy Leaderboard";
    const statCell = (val, hi) =>
      `<div style="width:120px;text-align:right;font-size:${hi ? 30 : 24}px;font-weight:${hi ? 800 : 600};color:${hi ? "#ffcc00" : "#f6f6f7"};">${val}</div>`;
    const headCell = label => `<div style="width:120px;text-align:right;">${label}</div>`;
    const body = `
        <div style="display:flex;align-items:center;padding:0 24px 14px;color:#9b9ba3;font-size:14px;letter-spacing:2px;text-transform:uppercase;">
          <div style="width:56px;">#</div>
          <div style="flex:1;">${isPlayer ? "Player" : "Contestant"}</div>
          ${isPlayer ? headCell("Matches") : ""}${headCell("Total")}
        </div>
        ${rows.map(r => `
          <div style="display:flex;align-items:center;background:#161618;border:1px solid #34343a;border-radius:16px;padding:16px 24px;margin-bottom:10px;">
            <div style="width:56px;">${shareRankBadge(r.i)}</div>
            <div style="flex:1;min-width:0;padding-right:16px;">
              <div style="font-size:27px;font-weight:700;line-height:1.15;">${esc(r.name)}</div>
              ${r.sub ? `<div style="font-size:16px;color:#9b9ba3;margin-top:3px;">${esc(r.sub)}</div>` : ""}
            </div>
            ${isPlayer ? statCell(fmtPts(r.days)) : ""}${statCell(fmtPts(r.total), true)}
          </div>`).join("")}`;
    return buildShareShell(subTitle, shareDateStr(), body);
  }
  function buildDayShareCard(day) {
    const rows = dayStandings(day).map((row, i) => ({ i, name: row.contestant ? row.contestant.name : "?", points: row.points }));
    const body = `
        <div style="display:flex;align-items:center;padding:0 24px 14px;color:#9b9ba3;font-size:14px;letter-spacing:2px;text-transform:uppercase;">
          <div style="width:56px;">#</div>
          <div style="flex:1;">Contestant</div>
          <div style="width:140px;text-align:right;">Points</div>
        </div>
        ${rows.map(r => `
          <div style="display:flex;align-items:center;background:#161618;border:1px solid #34343a;border-radius:16px;padding:16px 24px;margin-bottom:10px;">
            <div style="width:56px;">${shareRankBadge(r.i)}</div>
            <div style="flex:1;min-width:0;padding-right:16px;">
              <div style="font-size:27px;font-weight:700;line-height:1.15;">${esc(r.name)}</div>
            </div>
            <div style="width:140px;text-align:right;font-size:30px;font-weight:800;color:#ffcc00;">${fmtPts(r.points)}</div>
          </div>`).join("")}`;
    return buildShareShell("Today's Leaderboard", shareDateStr(), body);
  }
  async function captureAndDownload(node, filename, doneMsg) {
    document.body.appendChild(node);
    try {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      const opts = { pixelRatio: 2, backgroundColor: "#0a0a0b", cacheBust: true, width: 1080, height: node.scrollHeight };
      // First render is unreliable (fonts/styles not embedded yet) and often
      // comes back blank - run it as a throwaway, then capture for real.
      await window.htmlToImage.toPng(node, opts);
      const dataUrl = await window.htmlToImage.toPng(node, opts);
      const link = document.createElement("a");
      link.download = filename;
      link.href = dataUrl; link.click();
      ftoast(doneMsg, "good");
    } catch (err) {
      ftoast("Could not generate image", "bad");
    } finally {
      node.remove();
    }
  }
  async function shareBoard(kind) {
    const lib = window.htmlToImage;
    if (!lib || typeof lib.toPng !== "function") { ftoast("Image library still loading - try again", "bad"); return; }
    const stats = kind === "player" ? playerStats() : contestantStats();
    if (!stats.length) { ftoast("No results to share yet", "bad"); return; }
    ftoast("Building image...", "");
    const node = buildShareCard(kind, stats);
    const filename = kind === "player" ? "hccl-player-of-season-leaderboard.png" : "hccl-contestants-leaderboard.png";
    await captureAndDownload(node, filename, "Leaderboard image downloaded");
  }
  async function shareDay() {
    const lib = window.htmlToImage;
    if (!lib || typeof lib.toPng !== "function") { ftoast("Image library still loading - try again", "bad"); return; }
    const day = currentDay();
    if (!day || !day.entries.length || !day.hasResults) { ftoast("No results to share yet", "bad"); return; }
    ftoast("Building image...", "");
    const node = buildDayShareCard(day);
    await captureAndDownload(node, "hccl-today-leaderboard.png", "Day standings image downloaded");
  }

  /* ---------- manage ---------- */
  function renderManage() {
    const teamOpts = F.teams.map(t => `<option value="${t.id}" ${UI.editPlayerId && fPlayer(UI.editPlayerId) && fPlayer(UI.editPlayerId).teamId === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("");
    return `<div class="fan-board-grid">
      <div class="card"><h3 id="fanTeamTitle">${UI.editTeamId ? "Edit Team" : "Add Team"}</h3>
        <label>Team name<input id="fanTeamName" value="${UI.editTeamId && fTeam(UI.editTeamId) ? esc(fTeam(UI.editTeamId).name) : ""}" placeholder="e.g. Wizard Titans"/></label>
        <div class="form-row"><button class="btn btn-red" data-save-team>${UI.editTeamId ? "Save" : "Add team"}</button>${UI.editTeamId ? `<button class="btn btn-dark" data-cancel-team>Cancel</button>` : ""}</div>
        <div class="mini-list">${F.teams.length ? F.teams.map(t => `<div class="mini-row"><span class="ml-name">${esc(t.name)}</span><span class="ml-sub">${F.players.filter(p => p.teamId === t.id).length} players</span><button class="icon-btn" data-edit-team="${t.id}">✎</button><button class="icon-btn del" data-del-team="${t.id}">✕</button></div>`).join("") : `<p class="hint">No teams yet.</p>`}</div>
      </div>

      <div class="card"><h3 id="fanPlayerTitle">${UI.editPlayerId ? "Edit Player" : "Add Player"}</h3>
        <label>Player name<input id="fanPlayerName" value="${UI.editPlayerId && fPlayer(UI.editPlayerId) ? esc(fPlayer(UI.editPlayerId).name) : ""}" placeholder="e.g. Yasitha"/></label>
        <label>Team<select id="fanPlayerTeam">${teamOpts || `<option value="">Add a team first</option>`}</select></label>
        <div class="form-row"><button class="btn btn-red" data-save-player>${UI.editPlayerId ? "Save" : "Add player"}</button>${UI.editPlayerId ? `<button class="btn btn-dark" data-cancel-player>Cancel</button>` : ""}</div>
        <p class="hint">${F.players.length} players in the pool.</p>
        <div class="mini-list">${F.players.length ? F.players.map(p => `<div class="mini-row"><span class="ml-name">${esc(p.name)}</span><span class="ml-sub">${esc(teamName(p.teamId))}</span><button class="icon-btn" data-edit-player="${p.id}">✎</button><button class="icon-btn del" data-del-player="${p.id}">✕</button></div>`).join("") : `<p class="hint">No players. Add teams first, or import from the auction.</p>`}</div>
      </div>

      <div class="card"><h3>Contestants</h3>
        <p class="hint">These are added automatically when you enter a fantasy team on a match day.</p>
        <div class="mini-list">${F.contestants.length ? F.contestants.map(c => `<div class="mini-row"><span class="ml-name">${esc(c.name)}</span><button class="icon-btn del" data-del-contestant="${c.id}">✕</button></div>`).join("") : `<p class="hint">No contestants yet.</p>`}</div>
      </div>

      <div class="card"><h3>Data &amp; Backup</h3>
        <p class="hint">Pull tournament teams &amp; players straight from your auction squads (sold + retained).</p>
        <div class="form-row"><button class="btn btn-yellow" data-import-auction>⬇ Import from auction</button></div>
        <hr/>
        <div class="form-row"><button class="btn btn-dark" data-export>Export fantasy backup</button>
          <label class="btn btn-dark file-btn">Import backup<input type="file" id="fanImportFile" accept="application/json" hidden/></label></div>
        <hr/>
        ${usingFirestore ? `<p class="hint">Live cloud sync is on — everyone sees the same data. Copy this device's saved data into the shared cloud (one-time).</p>
        <div class="form-row"><button class="btn btn-yellow" data-cloud-upload>☁ Upload local data to cloud</button></div>
        <hr/>` : ""}
        <div class="form-row"><button class="btn btn-danger" data-reset>Erase fantasy data</button></div>
      </div>
    </div>`;
  }

  /* live update of the Captain/Vice-Captain selects + pick count */
  function refreshEntryPickUI() {
    const root = fanEl(); if (!root) return;
    const checks = [...root.querySelectorAll("[data-pick]")]; if (!checks.length) return;
    const picked = checks.filter(c => c.checked).map(c => c.getAttribute("data-pick"));
    checks.forEach(c => { c.disabled = !c.checked && picked.length >= 6; });
    const count = root.querySelector("#fanPickCount");
    if (count) { count.textContent = `${picked.length}/6 selected`; count.classList.toggle("full", picked.length === 6); }
    const cSel = root.querySelector("#fanC"), vSel = root.querySelector("#fanVC");
    if (!cSel || !vSel) return;
    const day = currentDay();
    const edit = UI.editEntryId && day ? day.entries.find(e => e.id === UI.editEntryId) : null;
    const cWant = cSel.value || (edit ? edit.captainId : "");
    const vWant = vSel.value || (edit ? edit.viceCaptainId : "");
    const opts = picked.map(pid => `<option value="${pid}">${esc(pname(pid))}</option>`).join("");
    cSel.innerHTML = `<option value="">- Captain -</option>` + opts;
    vSel.innerHTML = `<option value="">- Vice-Captain -</option>` + opts;
    if (picked.includes(cWant)) cSel.value = cWant;
    if (picked.includes(vWant)) vSel.value = vWant;
  }

  /* ============================================================
     ACTIONS
     ============================================================ */
  function newDay() {
    const el = fanEl().querySelector("#fanNewDate");
    const date = (el && el.value) || today();
    const d = { id: fid("d"), date, label: "", teamIds: [], performance: {}, entries: [], hasResults: false };
    F.days.unshift(d);
    UI.dayId = d.id; UI.editEntryId = null;
    saveF(); renderFanBody(); ftoast("Match day created", "good");
  }
  function delDay(id) {
    const d = fDay(id); if (!d) return;
    if (!confirm("Delete this match day and all its entries & results?")) return;
    F.days = F.days.filter(x => x.id !== id);
    if (UI.dayId === id) UI.dayId = F.days[0] ? F.days[0].id : null;
    saveF(); renderFanBody();
  }
  function toggleTeam(teamId) {
    const day = currentDay(); if (!day) return;
    const i = day.teamIds.indexOf(teamId);
    if (i >= 0) day.teamIds.splice(i, 1); else day.teamIds.push(teamId);
    saveF(); renderFanBody();
  }
  function saveEntry() {
    const day = currentDay(); if (!day) return;
    const root = fanEl();
    const name = (root.querySelector("#fanContestant").value || "").trim();
    if (!name) { ftoast("Enter the contestant's name", "bad"); return; }
    const picked = [...root.querySelectorAll("[data-pick]:checked")].map(c => c.getAttribute("data-pick"));
    if (picked.length !== 6) { ftoast("Pick exactly 6 players", "bad"); return; }
    const cId = root.querySelector("#fanC").value, vId = root.querySelector("#fanVC").value;
    if (!cId || !vId) { ftoast("Choose a Captain and Vice-Captain", "bad"); return; }
    if (cId === vId) { ftoast("Captain and Vice-Captain must be different", "bad"); return; }
    if (!picked.includes(cId) || !picked.includes(vId)) { ftoast("C / VC must be among your 6", "bad"); return; }

    let c = F.contestants.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (!c) { c = { id: fid("c"), name }; F.contestants.push(c); }
    const dup = day.entries.find(e => e.contestantId === c.id && e.id !== UI.editEntryId);
    if (dup) { ftoast(`${name} already has a team today - edit it instead`, "bad"); return; }

    if (UI.editEntryId) {
      const e = day.entries.find(x => x.id === UI.editEntryId);
      if (e) { e.contestantId = c.id; e.playerIds = picked; e.captainId = cId; e.viceCaptainId = vId; }
      UI.editEntryId = null;
    } else {
      day.entries.push({ id: fid("e"), contestantId: c.id, playerIds: picked, captainId: cId, viceCaptainId: vId });
    }
    saveF(); renderFanBody(); ftoast("Fantasy team saved", "good");
  }
  function delEntry(id) {
    const day = currentDay(); if (!day) return;
    day.entries = day.entries.filter(e => e.id !== id);
    if (UI.editEntryId === id) UI.editEntryId = null;
    saveF(); renderFanBody();
  }
  function saveResults() {
    const day = currentDay(); if (!day) return;
    const root = fanEl();
    const perf = {};
    dayPool(day).forEach(p => {
      const r = root.querySelector(`[data-runs="${p.id}"]`);
      const w = root.querySelector(`[data-wkts="${p.id}"]`);
      perf[p.id] = { runs: Number(r && r.value) || 0, wickets: Number(w && w.value) || 0 };
    });
    day.performance = perf; day.hasResults = true;
    saveF(); renderFanBody(); ftoast("Results saved - points calculated", "good");
  }
  function updateRowPts(input) {
    const row = input.closest(".fan-res-row"); if (!row) return;
    const r = Number(row.querySelector("[data-runs]").value) || 0;
    const w = Number(row.querySelector("[data-wkts]").value) || 0;
    const pts = row.querySelector(".frr-pts"); if (pts) pts.textContent = fmtPts(r + w * 10);
  }

  function saveTeam() {
    const el = fanEl().querySelector("#fanTeamName");
    const name = (el.value || "").trim();
    if (!name) { ftoast("Enter a team name", "bad"); return; }
    if (UI.editTeamId) { const t = fTeam(UI.editTeamId); if (t) t.name = name; UI.editTeamId = null; }
    else F.teams.push({ id: fid("t"), name });
    saveF(); renderFanBody(); ftoast("Team saved", "good");
  }
  function delTeam(id) {
    const t = fTeam(id); if (!t) return;
    if (!confirm(`Delete team "${t.name}" and its players?`)) return;
    const pids = new Set(F.players.filter(p => p.teamId === id).map(p => p.id));
    F.players = F.players.filter(p => p.teamId !== id);
    F.teams = F.teams.filter(x => x.id !== id);
    F.days.forEach(d => {
      d.teamIds = d.teamIds.filter(x => x !== id);
      pids.forEach(pid => delete d.performance[pid]);
      d.entries.forEach(e => {
        e.playerIds = e.playerIds.filter(x => !pids.has(x));
        if (pids.has(e.captainId)) e.captainId = null;
        if (pids.has(e.viceCaptainId)) e.viceCaptainId = null;
      });
    });
    if (UI.editTeamId === id) UI.editTeamId = null;
    saveF(); renderFanBody();
  }
  function savePlayer() {
    const root = fanEl();
    const name = (root.querySelector("#fanPlayerName").value || "").trim();
    const teamSel = root.querySelector("#fanPlayerTeam");
    const teamId = teamSel ? teamSel.value : "";
    if (!name) { ftoast("Enter a player name", "bad"); return; }
    if (!teamId) { ftoast("Add a team first", "bad"); return; }
    if (UI.editPlayerId) { const p = fPlayer(UI.editPlayerId); if (p) { p.name = name; p.teamId = teamId; } UI.editPlayerId = null; }
    else F.players.push({ id: fid("p"), name, teamId });
    saveF(); renderFanBody(); ftoast("Player saved", "good");
  }
  function delPlayer(id) {
    const p = fPlayer(id); if (!p) return;
    if (!confirm(`Delete player "${p.name}"?`)) return;
    F.players = F.players.filter(x => x.id !== id);
    F.days.forEach(d => {
      delete d.performance[id];
      d.entries.forEach(e => {
        e.playerIds = e.playerIds.filter(x => x !== id);
        if (e.captainId === id) e.captainId = null;
        if (e.viceCaptainId === id) e.viceCaptainId = null;
      });
    });
    if (UI.editPlayerId === id) UI.editPlayerId = null;
    saveF(); renderFanBody();
  }
  function delContestant(id) {
    const c = fContestant(id); if (!c) return;
    if (!confirm(`Delete contestant "${c.name}" and all their entries?`)) return;
    F.contestants = F.contestants.filter(x => x.id !== id);
    F.days.forEach(d => { d.entries = d.entries.filter(e => e.contestantId !== id); });
    saveF(); renderFanBody();
  }

  function importFromAuction() {
    let a; try { a = JSON.parse(localStorage.getItem(AKEY) || "null"); } catch (e) {}
    if (!a || !Array.isArray(a.teams)) { ftoast("No auction data found in this browser", "bad"); return; }
    const sold = (a.players || []).filter(p => p.status === "sold" && p.soldTo);
    if (!sold.length) { ftoast("No players are sold/retained in the auction yet", "bad"); return; }
    if ((F.teams.length || F.players.length) && !confirm("Replace the fantasy teams & players with your current auction squads?")) return;
    F.teams = a.teams.map(t => ({ id: "ft_" + t.id, name: t.name }));
    const ids = new Set(F.teams.map(t => t.id));
    F.players = sold.map(p => ({ id: "fp_" + p.id, name: p.name, teamId: "ft_" + p.soldTo })).filter(p => ids.has(p.teamId));
    saveF(); renderFanBody(); ftoast(`Imported ${F.teams.length} teams and ${F.players.length} players`, "good");
  }
  // One-time migration: copy this device's localStorage fantasy data into the
  // shared cloud. Additive (won't delete cloud entries that aren't local).
  function uploadLocalToCloud() {
    if (!usingFirestore || !canEditApp()) { ftoast("Cloud editing isn't available", "bad"); return; }
    const local = loadF();
    const n = local.teams.length + local.players.length + local.days.length + local.contestants.length;
    if (!n) { ftoast("No saved data on this device to upload", "bad"); return; }
    if (!confirm(`Add this device's ${local.teams.length} teams, ${local.players.length} players and ${local.days.length} match days to the shared cloud?`)) return;
    FS_COLLS.forEach(coll => {
      const have = new Set(F[coll].map(x => x.id));
      local[coll].forEach(it => { if (!have.has(it.id)) F[coll].push(it); });
    });
    saveF(); renderFantasy(); ftoast("Uploading to the cloud…", "good");
  }
  function exportF() {
    const blob = new Blob([JSON.stringify(F, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = "hccl-fantasy-backup.json"; link.click();
    URL.revokeObjectURL(url); ftoast("Backup downloaded", "good");
  }
  function importF(e) {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const data = JSON.parse(r.result);
        if (!Array.isArray(data.days) && !Array.isArray(data.players)) throw new Error("bad");
        F = normalizeF(data); saveF(); renderFantasy(); ftoast("Backup imported", "good");
      } catch (err) { ftoast("Invalid fantasy backup file", "bad"); }
      e.target.value = "";
    };
    r.readAsText(f);
  }
  function resetF() {
    if (!confirm("Erase ALL fantasy data (teams, players, days, entries)? This cannot be undone.")) return;
    F = defaultFantasy(); UI.sub = "manage"; UI.dayId = null;
    saveF(); renderFantasy(); ftoast("Fantasy data erased", "good");
  }

  /* ============================================================
     EVENTS (delegated on the persistent #view-fantasy container)
     ============================================================ */
  function onClick(e) {
    const t = e.target;
    const sub = t.closest("[data-fan-sub]");
    if (sub) { UI.sub = sub.getAttribute("data-fan-sub"); UI.editEntryId = UI.editTeamId = UI.editPlayerId = null; renderFanBody(); return; }
    if (t.closest("[data-new-day]")) return newDay();
    let m;
    if ((m = t.closest("[data-del-day]"))) return delDay(m.getAttribute("data-del-day"));
    if (t.closest("[data-add-entry]")) return saveEntry();
    if (t.closest("[data-cancel-entry]")) { UI.editEntryId = null; renderFanBody(); return; }
    if ((m = t.closest("[data-edit-entry]"))) { UI.editEntryId = m.getAttribute("data-edit-entry"); renderFanBody(); return; }
    if ((m = t.closest("[data-del-entry]"))) return delEntry(m.getAttribute("data-del-entry"));
    if (t.closest("[data-save-results]")) return saveResults();
    if (t.closest("[data-save-team]")) return saveTeam();
    if (t.closest("[data-cancel-team]")) { UI.editTeamId = null; renderFanBody(); return; }
    if ((m = t.closest("[data-edit-team]"))) { UI.editTeamId = m.getAttribute("data-edit-team"); renderFanBody(); return; }
    if ((m = t.closest("[data-del-team]"))) return delTeam(m.getAttribute("data-del-team"));
    if (t.closest("[data-save-player]")) return savePlayer();
    if (t.closest("[data-cancel-player]")) { UI.editPlayerId = null; renderFanBody(); return; }
    if ((m = t.closest("[data-edit-player]"))) { UI.editPlayerId = m.getAttribute("data-edit-player"); renderFanBody(); return; }
    if ((m = t.closest("[data-del-player]"))) return delPlayer(m.getAttribute("data-del-player"));
    if ((m = t.closest("[data-del-contestant]"))) return delContestant(m.getAttribute("data-del-contestant"));
    if ((m = t.closest("[data-share-board]"))) return shareBoard(m.getAttribute("data-share-board"));
    if (t.closest("[data-share-day]")) return shareDay();
    if (t.closest("[data-import-auction]")) return importFromAuction();
    if (t.closest("[data-export]")) return exportF();
    if (t.closest("[data-cloud-upload]")) return uploadLocalToCloud();
    if (t.closest("[data-reset]")) return resetF();
  }
  function onChange(e) {
    const t = e.target;
    if (t.id === "fanDaySelect") { UI.dayId = t.value; UI.editEntryId = null; renderFanBody(); return; }
    if (t.id === "fanImportFile") return importF(e);
    if (t.closest("[data-toggle-team]")) return toggleTeam(t.closest("[data-toggle-team]").getAttribute("data-toggle-team"));
    if (t.hasAttribute("data-pick")) return refreshEntryPickUI();
    if (t.hasAttribute("data-runs") || t.hasAttribute("data-wkts")) return updateRowPts(t);
  }

  /* ---------------- init ---------------- */
  function init() {
    const root = fanEl(); if (!root) return;
    root.addEventListener("click", onClick);
    root.addEventListener("change", onChange);
    root.addEventListener("input", e => {
      if (e.target.hasAttribute && (e.target.hasAttribute("data-runs") || e.target.hasAttribute("data-wkts"))) updateRowPts(e.target);
    });
    // Flush a re-render that was deferred while the editor was typing.
    root.addEventListener("focusout", () => { if (pendingRender) { pendingRender = false; renderFantasy(); } });
    const tabs = document.getElementById("tabs");
    if (tabs) tabs.addEventListener("click", e => { if (e.target.closest('[data-tab="fantasy"]')) renderFantasy(); });
    // Real-time data: mirror Firestore into F, but only once SIGNED IN (reads
    // require auth). Without Firebase we stay on localStorage as before.
    if (window.HCCL && typeof window.HCCL.onChange === "function") {
      window.HCCL.onChange(H => {
        if (H.configured && H.user && !usingFirestore && !fsFellBack && fsDb() && fsApi()) {
          usingFirestore = true;
          startFantasySync();
        }
        renderFantasy(); // re-render so gating + live data apply
      });
    }
    renderFantasy();
  }
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
  }

  // Node-only test hook (inert in the browser - `module` is undefined there)
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { _load: d => { F = normalizeF(d); }, dayPool, playerDayPoints, entryPoints, contestantStats, playerStats };
  }
})();
