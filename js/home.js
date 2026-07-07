/* ============================================================
   HCCL Home page  (renders into #view-home)

   Landing view after sign-in: a branded hero (league logo + big
   "HC CHAMPIONS LEAGUE" title + tagline) followed by a per-season
   view. A row of season tabs (Season 01 … 06) switches the active
   season; each season shows its honors podium (MVP / Champion /
   Runner-up bubbles + Most Runs / Most Wickets) and three detailed
   leaderboards (Overall / Batting / Bowling) built from the bundled
   per-season stats CSVs (window.HCCL_SEASON_STATS, season-stats-data.js).

   The SEASONS array below is the honors seed + offline fallback; when
   signed in, the same honors are read from Firestore (home/seasons) so
   they stay consistent across devices - "seed once, read-only",
   mirroring ranking.js. The leaderboard stats are always the bundled
   CSVs. No dependencies beyond the DOM.
   ============================================================ */
(function () {
  "use strict";

  // -------- season honors (replace with real values later) --------
  // champion / runnerUp are TEAM names (rendered as team-logo bubbles);
  // mvp / mostRuns / mostWickets are PLAYER names (rendered as photo bubbles).
  // Each: { no, year, ongoing?, champion, runnerUp, mvp, mostRuns, mostWickets }
  const SEASONS = [
    { no: 1, year: "NOV 2025 - DEC 2025", champion: "SUPER FIRE DRAGONS", runnerUp: "MATRIX", mvp: "SASINDU MADUSHAN", mostRuns: "HASITHA LAKMAL", mostWickets: "SASINDU MADUSHAN" },
    { no: 2, year: "DEC 2025", champion: "ZYCO KINGS", runnerUp: "WIZARD TITANS", mvp: "UDARA PERERA", mostRuns: "YASITHA NAWOD", mostWickets: "UDARA PERERA" },
    { no: 3, year: "JAN 2026", champion: "MIND GAMERS", runnerUp: "INVINCIBLE LORDS", mvp: "THENU PABEESHA", mostRuns: "THENU PABEESHA", mostWickets: "UDARA PERERA" },
    { no: 4, year: "FEB 2026 - MAR 2026", champion: "VELOCITY REAPERS", runnerUp: "AURA DYNASTY", mvp: "CHATHUKA LAKSHAN", mostRuns: "CHATHUKA LAKSHAN", mostWickets: "UDARA PERERA" },
    { no: 5, year: "APR 2026 - MAY 2026", champion: "SUPER FIRE DRAGONS", runnerUp: "WIZARD TITANS", mvp: "YATHISH LEYON", mostRuns: "SASINDU MADUSHAN", mostWickets: "UDARA PERERA" },
    { no: 6, year: "JUN 2026 - JUL 2026", ongoing: true, champion: "—", runnerUp: "—", mvp: "—", mostRuns: "SASINDU MADUSHAN", mostWickets: "YASITHA NAWOD" },
  ];

  // Bump when the SEASONS honors above change so an editor re-publishes the
  // cloud copy (home/seasons); everyone signed in reads that copy.
  const SEASONS_VERSION = "2026-07-06";
  const pad2 = n => String(n).padStart(2, "0");
  const num = v => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  let cloudSeasons = null; // seasons read from Firestore (home/seasons), or null
  // Cloud copy wins when present; otherwise the bundled SEASONS render offline.
  const getSeasons = () => (cloudSeasons && cloudSeasons.length) ? cloudSeasons : SEASONS;
  // Active season tab (season number). Defaults to the ongoing season, else the last.
  let activeSeason = (SEASONS.find(s => s.ongoing) || SEASONS[SEASONS.length - 1]).no;

  /* ---------- bubble helpers (team logos / player photos) ---------- */
  const BUBBLE_COLORS = ["#e10600", "#f5b301", "#22c55e", "#3b82f6", "#a855f7", "#ec4899", "#14b8a6", "#f97316"];
  function bubbleColor(s) {
    let h = 0; s = String(s || "");
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return BUBBLE_COLORS[Math.abs(h) % BUBBLE_COLORS.length];
  }
  const firstInitial = s => { const t = String(s || "").trim(); return t && t !== "—" ? t[0].toUpperCase() : "?"; };

  // Committed asset files (exact names; extensions vary between .png/.jpeg).
  // A team/player NAME resolves to its file via a lookup keyed by the lowercased
  // basename, so UPPERCASE values match regardless of case. Add a file here to
  // introduce a new team/player.
  const TEAM_LOGO_FILES = [
    "Aura Dynasty.jpeg", "Invincible Lords.jpeg", "Matrix.jpeg", "Mind Gamers.jpeg",
    "Silentearz.jpeg", "Super Fire Dragons.jpeg", "Velocity Reapers.jpeg", "Wizard Titans.jpeg", "Zyco Kings.jpeg",
  ];
  const PLAYER_PHOTO_FILES = [
    "Chathuka Lakshan.jpeg", "Hasitha Lakmal.png", "Sasindu Madushan.png", "Thenu Pabeesha.png",
    "Udara Perera.jpeg", "Yasitha Nawod.jpeg", "Yathish Leyon.png",
  ];
  const SEASON_LOGO_FILES = {
    1: "S1 LOGO.png", 2: "S2 LOGO.png", 3: "S3 LOGO.png",
    4: "S4 LOGO.png", 5: "S5 LOGO.png", 6: "S6 LOGO.jpg",
  };
  function fileIndex(files) {
    const m = {};
    files.forEach(f => { m[f.replace(/\.[^.]+$/, "").trim().toLowerCase()] = f; });
    return m;
  }
  const TEAM_LOGO_INDEX = fileIndex(TEAM_LOGO_FILES);
  const PLAYER_PHOTO_INDEX = fileIndex(PLAYER_PHOTO_FILES);
  // Encode so the spaces in folder/file names survive inside url()/href.
  const assetUrl = p => encodeURI(p);

  function teamLogo(team) {
    const f = TEAM_LOGO_INDEX[String(team || "").trim().toLowerCase()];
    return f ? assetUrl(`assets/Team Logos/${f}`) : "";
  }
  function playerPhoto(name) {
    const f = PLAYER_PHOTO_INDEX[String(name || "").trim().toLowerCase()];
    return f ? assetUrl(`assets/Key Players/${f}`) : "";
  }
  function seasonLogo(no) {
    const f = SEASON_LOGO_FILES[no];
    return f ? assetUrl(`assets/HCCL Logos/${f}`) : "";
  }
  // A round bubble: team logo / player photo if known, else a colored initial.
  function bubble(kind, value) {
    const img = kind === "team" ? teamLogo(value) : playerPhoto(value);
    return img
      ? `<span class="bubble" style="background-image:url('${img}')"></span>`
      : `<span class="bubble fallback" style="background:${bubbleColor(value)}">${esc(firstInitial(value))}</span>`;
  }

  function podiumItem(cls, role, kind, value) {
    return `<div class="podium-item ${cls}">
      ${bubble(kind, value)}
      <span class="podium-role">${role}</span>
      <span class="podium-name">${esc(value)}</span>
    </div>`;
  }
  function extraItem(icon, label, name) {
    return `<div class="extra-item">
      ${bubble("player", name)}
      <div class="extra-meta">
        <span class="extra-label">${icon} ${label}</span>
        <span class="extra-name">${esc(name)}</span>
      </div>
    </div>`;
  }

  function seasonBadge(s) {
    const l = seasonLogo(s.no);
    return l
      ? `<div class="season-no has-logo" style="background-image:url('${l}')"></div>`
      : `<div class="season-no">S${pad2(s.no)}</div>`;
  }

  /* ---------------- per-season stats (bundled CSVs) --------------- */
  // Column indices in "docs/HCCL Player Stats/Seasons/S#.csv" (see header row).
  const COL = {
    no: 0, name: 1, team: 2, matches: 3, pom: 4, runs: 6, batAvg: 7, batSR: 8,
    s30: 9, s50: 10, hs: 12, sixes: 13, fours: 14, wickets: 22, maiden: 24,
    bowlAvg: 25, bowlSR: 26, econ: 27, bestBowl: 30,
  };

  const seasonRowsCache = {};
  // Parse one season's CSV into an array of cell-arrays (header row dropped).
  // The season sheets have no quoted/comma-containing fields, so a plain split
  // is safe (kept minimal on purpose - regenerate season-stats-data.js to update).
  function seasonRows(no) {
    if (seasonRowsCache[no]) return seasonRowsCache[no];
    const store = window.HCCL_SEASON_STATS || {};
    const csv = store[no] != null ? store[no] : store[String(no)];
    if (!csv) return (seasonRowsCache[no] = []);
    const rows = String(csv).split(/\r?\n/)
      .map(l => l.trim()).filter(Boolean).slice(1)
      .map(line => line.split(",").map(c => c.trim()));
    return (seasonRowsCache[no] = rows);
  }

  // "4-11" style figure; blank / "0" (never bowled) shows as an em dash.
  const bbf = v => { const t = String(v || "").trim(); return (!t || t === "0") ? "—" : t; };
  // "30s/50s" and "4s/6s" combined cells.
  const slash = (a, b) => `${esc(a)}/${esc(b)}`;

  // Small team badge + name used inside leaderboard rows.
  function teamCell(team) {
    const img = teamLogo(team);
    const logo = img
      ? `<span class="lb-logo" style="background-image:url('${img}')"></span>`
      : `<span class="lb-logo fallback" style="background:${bubbleColor(team)}">${esc(firstInitial(team))}</span>`;
    return `<span class="lb-team">${logo}<span class="lb-team-name">${esc(team)}</span></span>`;
  }

  // Generic leaderboard table. columns: [{ label, num?, cell(row, rank) }]
  function statTable(title, note, columns, rows) {
    const head = columns.map(c => `<th class="${c.num ? "num" : ""}">${esc(c.label)}</th>`).join("");
    const body = rows.length
      ? rows.map((r, i) =>
          `<tr>${columns.map(c => `<td class="${c.num ? "num" : ""}">${c.cell(r, i)}</td>`).join("")}</tr>`).join("")
      : `<tr><td class="lb-empty" colspan="${columns.length}">No stats available for this season yet.</td></tr>`;
    return `<div class="lb">
      <div class="lb-head"><h4>${esc(title)}</h4>${note ? `<span class="lb-note">${esc(note)}</span>` : ""}</div>
      <div class="lb-scroll"><table class="lb-table">
        <thead><tr>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table></div>
    </div>`;
  }

  function overallBoard(rows) {
    const cols = [
      { label: "#", cell: r => esc(r[COL.no]) },
      { label: "Player", cell: r => `<span class="lb-player">${esc(r[COL.name])}</span>` },
      { label: "Team", cell: r => teamCell(r[COL.team]) },
      { label: "M", num: true, cell: r => esc(r[COL.matches]) },
      { label: "Runs", num: true, cell: r => esc(r[COL.runs]) },
      { label: "Bat Avg", num: true, cell: r => esc(r[COL.batAvg]) },
      { label: "Bat SR", num: true, cell: r => esc(r[COL.batSR]) },
      { label: "HS", num: true, cell: r => esc(r[COL.hs]) },
      { label: "30s/50s", num: true, cell: r => slash(r[COL.s30], r[COL.s50]) },
      { label: "4s/6s", num: true, cell: r => slash(r[COL.fours], r[COL.sixes]) },
      { label: "Wkts", num: true, cell: r => esc(r[COL.wickets]) },
      { label: "Bowl Avg", num: true, cell: r => esc(r[COL.bowlAvg]) },
      { label: "Econ", num: true, cell: r => esc(r[COL.econ]) },
      { label: "Bowl SR", num: true, cell: r => esc(r[COL.bowlSR]) },
      { label: "BBF", num: true, cell: r => esc(bbf(r[COL.bestBowl])) },
      { label: "Mdns", num: true, cell: r => esc(r[COL.maiden]) },
      { label: "POTM", num: true, cell: r => esc(r[COL.pom]) },
    ];
    return statTable("Overall Stats", "All players", cols, rows);
  }

  function battingBoard(rows) {
    const sorted = rows.slice().sort((a, b) => num(b[COL.runs]) - num(a[COL.runs]));
    const cols = [
      { label: "#", num: true, cell: (r, i) => String(i + 1) },
      { label: "Player", cell: r => `<span class="lb-player">${esc(r[COL.name])}</span>` },
      { label: "Team", cell: r => teamCell(r[COL.team]) },
      { label: "Runs", num: true, cell: r => esc(r[COL.runs]) },
      { label: "Bat Avg", num: true, cell: r => esc(r[COL.batAvg]) },
      { label: "Bat SR", num: true, cell: r => esc(r[COL.batSR]) },
      { label: "4s/6s", num: true, cell: r => slash(r[COL.fours], r[COL.sixes]) },
      { label: "30s/50s", num: true, cell: r => slash(r[COL.s30], r[COL.s50]) },
      { label: "HS", num: true, cell: r => esc(r[COL.hs]) },
    ];
    return statTable("Batting Stats", "Sorted by Runs", cols, sorted);
  }

  function bowlingBoard(rows) {
    const sorted = rows.slice().sort((a, b) => num(b[COL.wickets]) - num(a[COL.wickets]));
    const cols = [
      { label: "#", num: true, cell: (r, i) => String(i + 1) },
      { label: "Player", cell: r => `<span class="lb-player">${esc(r[COL.name])}</span>` },
      { label: "Team", cell: r => teamCell(r[COL.team]) },
      { label: "Wkts", num: true, cell: r => esc(r[COL.wickets]) },
      { label: "Econ", num: true, cell: r => esc(r[COL.econ]) },
      { label: "Bowl Avg", num: true, cell: r => esc(r[COL.bowlAvg]) },
      { label: "Mdns", num: true, cell: r => esc(r[COL.maiden]) },
      { label: "BBF", num: true, cell: r => esc(bbf(r[COL.bestBowl])) },
    ];
    return statTable("Bowling Stats", "Sorted by Wickets", cols, sorted);
  }

  /* ------------------------- rendering ------------------------- */
  function seasonTabsHtml(list) {
    return list.map(s =>
      `<button class="season-tab${s.no === activeSeason ? " active" : ""}" data-season="${s.no}">
        Season ${pad2(s.no)}${s.ongoing ? `<span class="season-tab-live">● LIVE</span>` : ""}
      </button>`).join("");
  }

  function seasonPanelHtml(s) {
    const rows = seasonRows(s.no);
    return `
      <article class="season-card">
        <div class="season-card-head">
          ${seasonBadge(s)}
          <div class="season-meta">
            <h3>Season ${pad2(s.no)}</h3>
            <span class="season-year">${esc(s.year)}${s.ongoing ? ` · <span class="season-live">ONGOING</span>` : ""}</span>
          </div>
        </div>
        <div class="podium">
          ${podiumItem("mvp", "MVP", "player", s.mvp)}
          ${podiumItem("champion", "Champion", "team", s.champion)}
          ${podiumItem("runner", "Runner-up", "team", s.runnerUp)}
        </div>
        <div class="season-extra">
          ${extraItem("🏏", "Most Runs", s.mostRuns)}
          ${extraItem("🎯", "Most Wickets", s.mostWickets)}
        </div>
        <div class="season-boards">
          <h3 class="season-boards-title">Season ${pad2(s.no)} · Player Stats</h3>
          ${overallBoard(rows)}
          ${battingBoard(rows)}
          ${bowlingBoard(rows)}
        </div>
      </article>`;
  }

  function render() {
    const view = document.getElementById("view-home");
    if (!view) return;
    const list = getSeasons();
    // Keep the active season in range if the honors list changes (cloud copy).
    if (!list.some(s => s.no === activeSeason)) activeSeason = list.length ? list[list.length - 1].no : 1;
    const active = list.find(s => s.no === activeSeason) || list[0];

    view.innerHTML = `
      <section class="home-hero">
        <div class="home-hero-logo" style="background-image:url('assets/brand-logo.jpg')"></div>
        <h1 class="home-hero-title">HC CHAMPIONS LEAGUE</h1>
        <p class="home-hero-sub">THE HOME OF HAND CRICKET CHAMPIONS</p>
        <p class="home-hero-tags">Live Auctions · Fantasy League · Player Rankings</p>
      </section>

      <section class="home-seasons">
        <nav class="season-tabs" id="seasonTabs">
          ${seasonTabsHtml(list)}
        </nav>
        <div class="season-panel" id="seasonPanel">
          ${active ? seasonPanelHtml(active) : ""}
        </div>
      </section>`;
  }

  function onClick(e) {
    const tab = e.target.closest("[data-season]");
    if (!tab) return;
    const no = parseInt(tab.getAttribute("data-season"), 10);
    if (!no || no === activeSeason) return;
    activeSeason = no;
    render();
    // Bring the freshly rendered season panel into view under the tabs.
    const panel = document.getElementById("seasonPanel");
    if (panel && panel.scrollIntoView) panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  /* ---------------- Firestore: read cloud honors + editor seed --------------- */
  // "Seed once, read-only" (mirrors ranking.js): everyone reads home/seasons; an
  // editor whose bundled data is newer than the stored doc (re)publishes it.
  // Viewers never write (Firestore rules enforce it) and fall back to SEASONS.
  let homeSyncStarted = false;
  function startHomeSync() {
    const H = window.HCCL;
    if (homeSyncStarted || !H || !H.configured || !H.user || !H.db || !H.fs) return;
    const fs = H.fs;
    if (!fs.doc || !fs.onSnapshot) return;
    homeSyncStarted = true;
    const ref = fs.doc(H.db, "home", "seasons");
    fs.onSnapshot(ref, snap => {
      const data = snap.exists() ? snap.data() : null;
      const fresh = !!(data && data.version === SEASONS_VERSION && Array.isArray(data.seasons));
      if (fresh) {
        cloudSeasons = data.seasons;
        render();
      }
      // Missing or stale -> an editor publishes the current bundled seasons.
      if (!fresh && H.canEdit && H.canEdit() && fs.setDoc) {
        fs.setDoc(ref, {
          version: SEASONS_VERSION,
          updatedAt: fs.serverTimestamp ? fs.serverTimestamp() : Date.now(),
          seasons: SEASONS,
        }).catch(err => console.error("home cloud seed failed:", err));
      }
    }, err => console.error("home snapshot error:", err));
  }

  function init() {
    const view = document.getElementById("view-home");
    if (!view) return;
    view.addEventListener("click", onClick);
    // Read cloud honors (and seed them, if an editor) once signed in.
    if (window.HCCL && typeof window.HCCL.onChange === "function") {
      window.HCCL.onChange(() => startHomeSync());
    }
    render();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
