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


  // champion / runnerUp are TEAM names (team-logo bubbles); mvp / mostRuns /
  // mostWickets are PLAYER names (photo bubbles).
  //
  // mostRuns / mostWickets are DERIVED from each season's stats sheet (its top
  // run-scorer / wicket-taker), so importing a CSV re-crowns them automatically.
  // The values below survive only as a fallback for a season with no sheet.
  // `mvp` stays manual - it's an award, not something the sheet can tell us.
  const SEASONS = [
    { no: 1, year: "NOV 2025 - DEC 2025", champion: "SUPER FIRE DRAGONS", runnerUp: "MATRIX", mvp: "SASINDU MADUSHAN", mostRuns: "HASITHA LAKMAL", mostWickets: "SASINDU MADUSHAN",
      playoffs: {
        q1:    { a: "SUPER FIRE DRAGONS", b: "INVINCIBLE LORDS", winner: "SUPER FIRE DRAGONS" },
        elim:  { a: "MATRIX", b: "THICKHEADERS", winner: "MATRIX" },
        q2:    { winner: "MATRIX" },
        final: { winner: "SUPER FIRE DRAGONS" },
      } },
    { no: 2, year: "DEC 2025", champion: "ZYCO KINGS", runnerUp: "WIZARD TITANS", mvp: "UDARA PERERA", mostRuns: "YASITHA NAWOD", mostWickets: "UDARA PERERA",
      playoffs: {
        q1:    { a: "ZYCO KINGS", b: "WIZARD TITANS", winner: "ZYCO KINGS" },
        elim:  { a: "SUPER FIRE DRAGONS", b: "MIND GAMERS", winner: "SUPER FIRE DRAGONS" },
        q2:    { winner: "WIZARD TITANS" },
        final: { winner: "ZYCO KINGS" },
      } },
    { no: 3, year: "JAN 2026", champion: "MIND GAMERS", runnerUp: "INVINCIBLE LORDS", mvp: "THENU PABEESHA", mostRuns: "THENU PABEESHA", mostWickets: "UDARA PERERA",
      playoffs: {
        q1:    { a: "MIND GAMERS", b: "WIZARD TITANS", winner: "MIND GAMERS" },
        elim:  { a: "INVINCIBLE LORDS", b: "MATRIX", winner: "INVINCIBLE LORDS" },
        q2:    { winner: "INVINCIBLE LORDS" },
        final: { winner: "MIND GAMERS" },
      } },
    { no: 4, year: "FEB 2026 - MAR 2026", champion: "VELOCITY REAPERS", runnerUp: "AURA DYNASTY", mvp: "CHATHUKA LAKSHAN", mostRuns: "CHATHUKA LAKSHAN", mostWickets: "UDARA PERERA",
      playoffs: {
        q1:    { a: "AURA DYNASTY", b: "VELOCITY REAPERS", winner: "AURA DYNASTY" },
        elim:  { a: "SUPER FIRE DRAGONS", b: "SILENTEARZ", winner: "SUPER FIRE DRAGONS" },
        q2:    { winner: "VELOCITY REAPERS" },
        final: { winner: "VELOCITY REAPERS" },
      } },
    { no: 5, year: "APR 2026 - MAY 2026", champion: "SUPER FIRE DRAGONS", runnerUp: "WIZARD TITANS", mvp: "YATHISH LEYON", mostRuns: "SASINDU MADUSHAN", mostWickets: "UDARA PERERA",
      playoffs: {
        q1:    { a: "WIZARD TITANS", b: "MIND GAMERS", winner: "WIZARD TITANS" },
        elim:  { a: "SUPER FIRE DRAGONS", b: "MATRIX", winner: "SUPER FIRE DRAGONS" },
        q2:    { winner: "SUPER FIRE DRAGONS" },
        final: { winner: "SUPER FIRE DRAGONS" },
      } },
    // Ongoing: fill slots in as they're decided. "" (or "TBD") renders a TBD
    // placeholder, so a partly-known bracket is fine - name teams as they qualify.
    { no: 6, year: "JUN 2026 - JUL 2026", ongoing: true, champion: "—", runnerUp: "—", mvp: "—", mostRuns: "SASINDU MADUSHAN", mostWickets: "CHAMIKA KAUSHILA",
      playoffs: {
        q1:    { a: "VELOCITY REAPERS", b: "INVINCIBLE LORDS", winner: "" },
        elim:  { a: "SUPER FIRE DRAGONS", b: "SILENTEARZ", winner: "" },
        q2:    { winner: "" },
        final: { winner: "" },
      } },
  ];

  // The cloud copy (home/seasons) WINS over the bundle above, and it is only
  // re-published when the stored version differs. So the version is DERIVED from
  // the SEASONS content: edit anything above and the hash changes, the stored
  // copy looks stale, and the next editor to load the page re-publishes it.
  // (A hand-maintained version string meant an edit here silently did nothing -
  // the stale cloud copy kept overriding it.) Change SEASONS_SCHEMA only to
  // force a reseed without touching the data.
  const SEASONS_SCHEMA = "v2";
  function hashJson(value) {
    const s = JSON.stringify(value);
    let h = 5381; // djb2/xor - short, stable, and dependency-free
    for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }
  const SEASONS_VERSION = `${SEASONS_SCHEMA}-${hashJson(SEASONS)}`;
  // Bump whenever the bundled season CSVs (season-stats-data.js) are regenerated
  // so an editor re-uploads the per-season stats to Firestore (seasonStats/S#).
  const SEASON_STATS_VERSION = "2026-07-07";
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
  // Active leaderboard sub-tab within a season: "overall" | "batting" | "bowling".
  let activeBoard = "overall";

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
    "Thickheaders.png", "Noble Knights.png",
  ];
  const PLAYER_PHOTO_FILES = [
    "Chathuka Lakshan.jpeg", "Hasitha Lakmal.png", "Sasindu Madushan.png", "Thenu Pabeesha.png",
    "Udara Perera.jpeg", "Yasitha Nawod.jpeg", "Yathish Leyon.png", "Chamika Kaushila.jpeg",
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

  /* -------------------- playoffs bracket (IPL style) -------------------- */
  // Three columns: [Qualifier 1 / Eliminator] -> [Qualifier 2] -> [Final].
  // Q1 winner goes straight to the Final; Q1 loser drops to Q2, where it meets
  // the Eliminator winner; the Q2 winner joins the Final.
  //
  // Only q1/elim line-ups + the three winners are authored (see SEASONS above);
  // Q2 and Final line-ups are DERIVED here so the bracket is always self-
  // consistent. Any slot we can't resolve renders as a "TBD" placeholder, which
  // is what an ongoing season (no `playoffs` key) shows for every slot.
  // Tokens an author may use for "not decided yet" - all normalise to "" (TBD).
  const UNKNOWN_TEAM = new Set(["", "TBD", "TBA", "-", "--", "—", "?", "N/A"]);
  function resolvePlayoffs(s) {
    const p = (s && s.playoffs) || null;
    const t = v => {
      const str = v == null ? "" : String(v).trim();
      return UNKNOWN_TEAM.has(str.toUpperCase()) ? "" : str;
    };
    const empty = { a: "", b: "", winner: "" };
    if (!p || !p.q1 || !p.elim) return { q1: empty, elim: empty, q2: empty, final: empty };

    const q1a = t(p.q1.a), q1b = t(p.q1.b), q1w = t(p.q1.winner);
    // The loser resolves ONLY when the winner is one of the two named teams.
    // Guarding on q1w first matters: with no winner yet, both it and an unnamed
    // opponent are "", so a bare `q1w === q1a` would wrongly drop the OTHER,
    // real team into Qualifier 2 as a loser of a match that hasn't happened.
    const q1l = !q1w ? "" : (q1w === q1a ? q1b : (q1w === q1b ? q1a : ""));
    const ea = t(p.elim.a), eb = t(p.elim.b), ew = t(p.elim.winner);
    const q2w = t(p.q2 && p.q2.winner);
    const fw = t(p.final && p.final.winner);
    return {
      q1:    { a: q1a, b: q1b, winner: q1w },
      elim:  { a: ea, b: eb, winner: ew },
      q2:    { a: q1l, b: ew, winner: q2w },   // Q1 loser vs Eliminator winner
      final: { a: q1w, b: q2w, winner: fw },   // Q1 winner vs Q2 winner
    };
  }

  // One team row. `data-team` is the hover key - omitted for TBD so unresolved
  // slots aren't hoverable. The same attribute tags the connector paths, so
  // highlighting a team lights up every box AND line it passes through.
  function plTeam(team, seed, isWinner) {
    const known = !!team;
    const cls = `pl-team${isWinner ? " win" : ""}${known ? "" : " tbd"}`;
    return `<div class="${cls}"${known ? ` data-team="${esc(team)}"` : ""}>
      ${seed ? `<span class="pl-seed">${seed}</span>` : `<span class="pl-seed blank"></span>`}
      ${known ? logoSpan(team, "pl-logo") : `<span class="pl-logo fallback tbd">?</span>`}
      <span class="pl-name">${esc(known ? team : "TBD")}</span>
      ${isWinner ? `<span class="pl-check" title="Winner">✓</span>` : ""}
    </div>`;
  }

  function plMatch(slot, title, teamsHtml) {
    return `<div class="pl-match pl-${slot}" data-slot="${slot}">
      <div class="pl-match-title">${esc(title)}</div>
      ${teamsHtml}
    </div>`;
  }

  function playoffsHtml(s) {
    const p = resolvePlayoffs(s);
    // A team "wins" its match only when the winner is actually that named team.
    const won = (m, team) => !!team && m.winner === team;
    // Connector: leaves `from` box at fy (0-1 of its height), enters `to` at ty.
    // `team` is the club travelling that edge - drives the hover trace.
    const line = (from, fy, to, ty, team) =>
      `<path class="pl-line" data-from="${from}" data-fy="${fy}" data-to="${to}" data-ty="${ty}"${team ? ` data-team="${esc(team)}"` : ""} />`;

    return `<section class="playoffs">
      <div class="playoffs-head">
        <h3 class="playoffs-title">Playoffs</h3>
        <span class="playoffs-hint"></span>
      </div>
      <div class="pl-bracket">
        <svg class="pl-lines" aria-hidden="true" focusable="false">
          ${line("q1", 0.34, "final", 0.34, p.q1.winner)}
          ${line("q1", 0.74, "q2", 0.34, p.q2.a)}
          ${line("elim", 0.5, "q2", 0.74, p.q2.b)}
          ${line("q2", 0.5, "final", 0.74, p.final.b)}
        </svg>
        ${plMatch("q1", "Qualifier 1",
          plTeam(p.q1.a, 1, won(p.q1, p.q1.a)) + plTeam(p.q1.b, 2, won(p.q1, p.q1.b)))}
        ${plMatch("elim", "Eliminator",
          plTeam(p.elim.a, 3, won(p.elim, p.elim.a)) + plTeam(p.elim.b, 4, won(p.elim, p.elim.b)))}
        ${plMatch("q2", "Qualifier 2",
          plTeam(p.q2.a, 0, won(p.q2, p.q2.a)) + plTeam(p.q2.b, 0, won(p.q2, p.q2.b)))}
        ${plMatch("final", "Final",
          plTeam(p.final.a, 0, won(p.final, p.final.a)) + plTeam(p.final.b, 0, won(p.final, p.final.b)))}
      </div>
    </section>`;
  }

  // Connector paths are drawn from measured box geometry (rather than hard-coded
  // coordinates) so the bracket stays correct at any width. Re-run after every
  // render and on resize. Below the mobile breakpoint the boxes stack and CSS
  // hides the <svg>, so the stale `d` attributes are harmless.
  function drawBracketLines() {
    const root = document.querySelector(".pl-bracket");
    if (!root) return;
    const svg = root.querySelector(".pl-lines");
    if (!svg) return;
    const box = root.getBoundingClientRect();
    if (!box.width || !box.height) return;
    svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
    root.querySelectorAll(".pl-line").forEach(path => {
      const from = root.querySelector(`[data-slot="${path.getAttribute("data-from")}"]`);
      const to = root.querySelector(`[data-slot="${path.getAttribute("data-to")}"]`);
      if (!from || !to) return;
      const f = from.getBoundingClientRect(), t = to.getBoundingClientRect();
      const x1 = f.right - box.left, y1 = f.top - box.top + f.height * parseFloat(path.getAttribute("data-fy"));
      const x2 = t.left - box.left, y2 = t.top - box.top + t.height * parseFloat(path.getAttribute("data-ty"));
      const mx = x1 + (x2 - x1) / 2; // S-curve control points sit on the midline
      path.setAttribute("d", `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`);
    });
  }

  // Hover trace: light up every element tagged with the hovered team (its boxes
  // AND the connector edges it travels), and dim the rest.
  function traceTeam(team) {
    const root = document.querySelector(".pl-bracket");
    if (!root) return;
    root.classList.toggle("tracing", !!team);
    root.querySelectorAll("[data-team]").forEach(el =>
      el.classList.toggle("on", !!team && el.getAttribute("data-team") === team));
  }

  function onBracketHover(e) {
    if (!e.target.closest) return;
    const row = e.target.closest(".pl-team[data-team]");
    traceTeam(row ? row.getAttribute("data-team") : "");
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
  // Header spot-checks used to validate an imported Season Stats CSV against
  // the same fixed 36-column layout the COL map above assumes.
  const SEASON_CSV_HEADER_CHECKS = [
    [0, /^no\.?$/i], [1, /player name/i], [2, /team name/i],
    [6, /runs scored/i], [22, /^wickets$/i], [30, /best bowl/i],
  ];

  // Per-season CSV text uploaded live by an editor for the ongoing season
  // (Firestore seasonStatsLive/S#), keyed by season number. Wins over the
  // bundled window.HCCL_SEASON_STATS when present - see seasonRows() below.
  const liveCsvBySeason = {};
  let liveSeasonNo = null; // season number the Firestore listener currently follows
  let liveUnsub = null;    // unsubscribe fn for that listener

  const seasonRowsCache = {};
  // Parse one season's CSV into an array of cell-arrays (header row dropped).
  // The season sheets have no quoted/comma-containing fields, so a plain split
  // is safe (kept minimal on purpose - regenerate season-stats-data.js to update).
  function seasonRows(no) {
    if (seasonRowsCache[no]) return seasonRowsCache[no];
    const store = window.HCCL_SEASON_STATS || {};
    const csv = liveCsvBySeason[no] != null ? liveCsvBySeason[no]
      : (store[no] != null ? store[no] : store[String(no)]);
    if (!csv) return (seasonRowsCache[no] = []);
    const rows = String(csv).split(/\r?\n/)
      .map(l => l.trim()).filter(Boolean).slice(1)
      .map(line => line.split(",").map(c => c.trim()));
    return (seasonRowsCache[no] = rows);
  }

  // Same CSV, but as an array of {header: value} objects - the shape uploaded to
  // Firestore (seasonStats/S#) so the cloud copy is self-describing / queryable.
  function seasonPlayers(no) {
    const store = window.HCCL_SEASON_STATS || {};
    const csv = store[no] != null ? store[no] : store[String(no)];
    if (!csv) return [];
    const lines = String(csv).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) return [];
    const header = lines[0].split(",").map(h => h.trim());
    return lines.slice(1).map(line => {
      const cells = line.split(",").map(c => c.trim());
      const obj = {};
      header.forEach((h, i) => { obj[h] = cells[i] != null ? cells[i] : ""; });
      return obj;
    });
  }

  // "4-11" style figure; blank / "0" (never bowled) shows as an em dash.
  const bbf = v => { const t = String(v || "").trim(); return (!t || t === "0") ? "—" : t; };
  // "30s/50s" and "4s/6s" combined cells.
  const slash = (a, b) => `${esc(a)}/${esc(b)}`;

  // Small team badge + name used inside leaderboard rows.
  // A small round team badge: the logo when we have one, else a colored initial.
  function logoSpan(team, cls) {
    const img = teamLogo(team);
    return img
      ? `<span class="${cls}" style="background-image:url('${img}')"></span>`
      : `<span class="${cls} fallback" style="background:${bubbleColor(team)}">${esc(firstInitial(team))}</span>`;
  }

  function teamCell(team) {
    return `<span class="lb-team">${logoSpan(team, "lb-logo")}<span class="lb-team-name">${esc(team)}</span></span>`;
  }

  // Generic leaderboard table. columns: [{ label, num?, cell(row, rank) }]
  function statTable(title, columns, rows) {
    const head = columns.map(c => `<th class="${c.num ? "num" : ""}">${esc(c.label)}</th>`).join("");
    const body = rows.length
      ? rows.map((r, i) =>
          `<tr>${columns.map(c => `<td class="${c.num ? "num" : ""}">${c.cell(r, i)}</td>`).join("")}</tr>`).join("")
      : `<tr><td class="lb-empty" colspan="${columns.length}">No stats available for this season yet.</td></tr>`;
    return `<div class="lb">
      <div class="lb-head"><h4>${esc(title)}</h4></div>
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
    return statTable("Overall Stats", cols, rows);
  }

  /* ---- season leaders, derived from the season's own stats sheet ---- */
  // Ranking orders, shared by the leaderboards and the Most Runs / Most Wickets
  // bubbles so a player can never top the board yet miss the bubble. Ties break
  // on the next most meaningful stat, then on name so the order is stable.
  const byRuns = (a, b) =>
    num(b[COL.runs]) - num(a[COL.runs]) ||
    num(b[COL.batAvg]) - num(a[COL.batAvg]) ||
    num(b[COL.batSR]) - num(a[COL.batSR]) ||
    String(a[COL.name]).localeCompare(String(b[COL.name]));
  const byWickets = (a, b) =>
    num(b[COL.wickets]) - num(a[COL.wickets]) ||
    num(a[COL.econ]) - num(b[COL.econ]) ||      // tie on wickets -> better (lower) economy
    num(a[COL.bowlAvg]) - num(b[COL.bowlAvg]) ||
    String(a[COL.name]).localeCompare(String(b[COL.name]));

  // Top player by `cmp`, but only once someone has actually scored/taken one -
  // early in an ongoing season every row is 0 and the "leader" is meaningless.
  // Returned upper-cased to match the podium's styling; photo lookup is
  // case-insensitive, so the bubble still resolves.
  function seasonLeader(rows, cmp, statIdx) {
    if (!rows.length) return "";
    const top = rows.slice().sort(cmp)[0];
    return num(top[statIdx]) > 0 ? String(top[COL.name]).trim().toUpperCase() : "";
  }

  function battingBoard(rows) {
    const sorted = rows.slice().sort(byRuns);
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
    return statTable("Batting Stats", cols, sorted);
  }

  function bowlingBoard(rows) {
    const sorted = rows.slice().sort(byWickets);
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
    return statTable("Bowling Stats", cols, sorted);
  }

  const BOARDS = [
    { key: "overall", label: "Overall", build: overallBoard },
    { key: "batting", label: "Batting", build: battingBoard },
    { key: "bowling", label: "Bowling", build: bowlingBoard },
  ];
  // Only the active leaderboard is shown; the sub-tabs above switch between them
  // so viewers don't scroll past three stacked tables.
  function boardPanelHtml(rows) {
    const b = BOARDS.find(x => x.key === activeBoard) || BOARDS[0];
    return b.build(rows);
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
    // Derived from this season's stats sheet, so importing a new CSV for the
    // ongoing season re-crowns these automatically. The authored SEASONS values
    // are only a fallback for a season with no sheet (or no runs/wickets yet).
    const mostRuns = seasonLeader(rows, byRuns, COL.runs) || s.mostRuns || "—";
    const mostWickets = seasonLeader(rows, byWickets, COL.wickets) || s.mostWickets || "—";
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
        ${playoffsHtml(s)}
        <div class="season-extra">
          ${extraItem("🏏", "Most Runs", mostRuns)}
          ${extraItem("🎯", "Most Wickets", mostWickets)}
        </div>
        <div class="season-boards">
          <div class="season-boards-head">
            <h3 class="season-boards-title">Season ${pad2(s.no)} · Player Stats</h3>
            ${s.ongoing ? `
            <label class="btn btn-yellow file-btn season-stats-import" title="Upload the latest Season ${pad2(s.no)} stats CSV - updates the leaderboard live for everyone">
              <span>⬆ Import Season Stats</span>
              <input type="file" class="season-stats-import-file" data-season="${s.no}" accept=".csv,text/csv" hidden />
            </label>` : ""}
          </div>
          <div class="board-tabs" role="tablist">
            ${BOARDS.map(b => `<button class="board-tab${b.key === activeBoard ? " active" : ""}" data-board="${b.key}">${esc(b.label)}</button>`).join("")}
          </div>
          <div class="board-panel" id="boardPanel">
            ${boardPanelHtml(rows)}
          </div>
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
    // Connectors need the boxes laid out first; measure on the next frame.
    requestAnimationFrame(drawBracketLines);
  }

  function onClick(e) {
    // Leaderboard sub-tab: swap only the board panel so the page doesn't jump.
    const board = e.target.closest("[data-board]");
    if (board) {
      const key = board.getAttribute("data-board");
      if (key === activeBoard) return;
      activeBoard = key;
      const s = getSeasons().find(x => x.no === activeSeason);
      const panel = document.getElementById("boardPanel");
      if (panel && s) panel.innerHTML = boardPanelHtml(seasonRows(s.no));
      document.querySelectorAll(".board-tab").forEach(t =>
        t.classList.toggle("active", t.getAttribute("data-board") === activeBoard));
      return;
    }
    // Season tab: rebuild the whole panel for the picked season.
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
      // The ongoing season may have changed along with the honors - keep the
      // live-stats listener pointed at whichever season is ongoing now.
      startSeasonLiveSync();
    }, err => console.error("home snapshot error:", err));
  }

  /* ------ Firestore: upload per-season stats (editors, seed once) ------ */
  // "Seed once, read-only" for the detailed stats: an editor publishes the
  // bundled season CSVs to Firestore as one document per season
  // (seasonStats/S1 … seasonStats/S6, each { season, players:[…] }) plus a small
  // seasonStats/index. Viewers never write (rules enforce it). The site itself
  // still renders from the bundled CSVs; this cloud copy is the shared record.
  let statsSeedTried = false;
  async function seedSeasonStats() {
    const H = window.HCCL;
    if (!H || !H.configured || !H.db || !H.fs || !H.canEdit || !H.canEdit()) return;
    const fs = H.fs;
    if (!fs.doc || !fs.getDoc || !fs.writeBatch) return;
    if (statsSeedTried) return;           // one attempt per page load
    statsSeedTried = true;
    try {
      const idxRef = fs.doc(H.db, "seasonStats", "index");
      const idxSnap = await fs.getDoc(idxRef);
      if (idxSnap.exists() && idxSnap.data().version === SEASON_STATS_VERSION) return; // already current
      const by = (H.user && (H.user.displayName || H.user.email)) || "";
      const stamp = fs.serverTimestamp ? fs.serverTimestamp() : Date.now();
      const batch = fs.writeBatch(H.db);
      const summary = [];
      getSeasons().forEach(s => {
        const players = seasonPlayers(s.no);
        if (!players.length) return;
        batch.set(fs.doc(H.db, "seasonStats", "S" + s.no), {
          season: s.no,
          year: s.year || "",
          ongoing: !!s.ongoing,
          version: SEASON_STATS_VERSION,
          updatedAt: stamp,
          updatedBy: by,
          playerCount: players.length,
          players,
        });
        summary.push({ season: s.no, players: players.length });
      });
      batch.set(idxRef, { version: SEASON_STATS_VERSION, seasons: summary, updatedAt: stamp, updatedBy: by });
      await batch.commit();
      console.log(`season stats uploaded to Firestore (seasonStats/*, ${SEASON_STATS_VERSION})`);
    } catch (e) {
      statsSeedTried = false;             // allow a retry on the next auth change
      console.error("season stats upload failed (need editor + published rules):", e);
    }
  }

  /* ------ Firestore: live stats override for the ONGOING season only ------ */
  // "Store raw CSV, recompute client-side" (mirrors ranking.js's ranking/stats):
  // an editor imports the day's Season Stats CSV; it's published as-is to
  // seasonStatsLive/S{no}; every signed-in client's onSnapshot listener picks
  // it up and seasonRows() prefers it over the bundled CSV for that season.
  // Only ever follows whichever season is currently flagged `ongoing` - a
  // finished season always renders from the committed bundle.
  function notify(msg, kind) {
    if (typeof window.toast === "function") window.toast(msg, kind);
    else console.log("[home]", msg);
  }

  // Validate an uploaded CSV against the fixed 36-column Season Stats layout
  // the COL map assumes. Every leaderboard cell is looked up by position, so a
  // wrong-shaped file must be rejected outright rather than silently accepted -
  // an accepted mismatch would corrupt every stat cell with no visible sign.
  function validateSeasonCsv(text) {
    const parseCsv = window.HCCLRanking && window.HCCLRanking.parseCsv;
    let grid = [];
    try { grid = parseCsv ? parseCsv(text) : null; } catch (e) { grid = null; }
    if (!grid) return { ok: false, reason: "Couldn't read that file as CSV." };
    grid = grid.filter(r => r && r.some(c => String(c || "").trim() !== ""));
    if (grid.length < 2) return { ok: false, reason: "Empty CSV - add at least one player row." };
    const header = grid[0].map(c => String(c || "").trim());
    while (header.length && !header[header.length - 1]) header.pop(); // trailing Excel-export blanks
    if (header.length !== 36) {
      return { ok: false, reason: `Expected 36 columns (Season Stats format), found ${header.length}.` };
    }
    for (const [i, re] of SEASON_CSV_HEADER_CHECKS) {
      if (!re.test(header[i] || "")) {
        return { ok: false, reason: `That doesn't look like a Season Stats CSV - column ${i + 1} should be "${header[i] != null ? header[i] : ""}".` };
      }
    }
    const dataRows = grid.slice(1);
    if (dataRows.some(r => r.length < 31)) {
      return { ok: false, reason: "Some rows are missing columns - check the file wasn't truncated." };
    }
    return { ok: true, playerCount: dataRows.length };
  }

  function startSeasonLiveSync() {
    const H = window.HCCL;
    if (!H || !H.configured || !H.user || !H.db || !H.fs) return;
    const fs = H.fs;
    if (!fs.doc || !fs.onSnapshot) return;
    const ongoing = getSeasons().find(s => s.ongoing);
    const no = ongoing ? ongoing.no : null;
    if (no === liveSeasonNo) return; // already following the right season (or correctly following none)
    if (liveUnsub) { liveUnsub(); liveUnsub = null; }
    // A season that just stopped being "ongoing" must immediately revert to
    // the committed bundle, not keep showing a stale import.
    if (liveSeasonNo != null) { delete liveCsvBySeason[liveSeasonNo]; delete seasonRowsCache[liveSeasonNo]; }
    liveSeasonNo = no;
    if (no == null) { render(); return; }
    const ref = fs.doc(H.db, "seasonStatsLive", "S" + no);
    liveUnsub = fs.onSnapshot(ref, snap => {
      const data = snap.exists() ? snap.data() : null;
      const csv = data && typeof data.csv === "string" && data.csv.trim() ? data.csv : null;
      if (csv) liveCsvBySeason[no] = csv; else delete liveCsvBySeason[no];
      delete seasonRowsCache[no]; // invalidate BEFORE render() recomputes
      render();
    }, err => console.error("season live stats snapshot error:", err));
  }

  // Editor-only: publish an uploaded Season Stats CSV so it updates the
  // ongoing season's leaderboard for everyone (or apply locally when offline).
  async function importSeasonCsv(file, seasonNo) {
    if (!file || !seasonNo) return;
    const H = window.HCCL;
    let text = "";
    try { text = await file.text(); } catch (e) { notify("Couldn't read that file.", "bad"); return; }
    const check = validateSeasonCsv(text);
    if (!check.ok) { notify(check.reason, "bad"); return; }
    // Re-confirm this season is still ongoing (the button may be stale if the
    // tab's been open across a season change).
    const ongoing = getSeasons().find(s => s.ongoing);
    if (!ongoing || ongoing.no !== seasonNo) { notify("That season is no longer ongoing - refresh and try again.", "bad"); return; }

    if (H && H.configured && H.db && H.fs && H.fs.setDoc && H.canEdit && H.canEdit()) {
      try {
        const ref = H.fs.doc(H.db, "seasonStatsLive", "S" + seasonNo);
        await H.fs.setDoc(ref, {
          season: seasonNo, csv: text, playerCount: check.playerCount,
          updatedAt: H.fs.serverTimestamp ? H.fs.serverTimestamp() : Date.now(),
          updatedBy: (H.user && (H.user.displayName || H.user.email)) || "",
        });
        notify(`Season ${pad2(seasonNo)} stats imported - ${check.playerCount} players. Live for everyone.`, "good");
        // onSnapshot re-renders every device (including this one).
      } catch (e) {
        console.error("season stats import failed:", e);
        notify("Upload failed - need moderator/admin + published rules.", "bad");
      }
      return;
    }
    if (H && H.configured) { notify("Only moderators/admins can import stats.", "bad"); return; }
    // Offline / open mode (no cloud): apply on this device only.
    liveCsvBySeason[seasonNo] = text; delete seasonRowsCache[seasonNo]; render();
    notify(`Season ${pad2(seasonNo)} stats imported - ${check.playerCount} players (this device only).`, "good");
  }

  function init() {
    const view = document.getElementById("view-home");
    if (!view) return;
    view.addEventListener("click", onClick);
    view.addEventListener("change", e => {
      const inp = e.target.closest(".season-stats-import-file");
      if (inp && inp.files && inp.files[0]) {
        const no = parseInt(inp.getAttribute("data-season"), 10);
        if (no) importSeasonCsv(inp.files[0], no);
        inp.value = "";
      }
    });
    // Playoffs bracket: trace a team's path on hover, and drop the trace when
    // the pointer leaves the view entirely (mouseover alone never fires then).
    view.addEventListener("mouseover", onBracketHover);
    view.addEventListener("mouseleave", () => traceTeam(""));
    // Connector geometry is measured, so it must be recomputed when the width changes.
    window.addEventListener("resize", () => requestAnimationFrame(drawBracketLines));
    // Read cloud honors + upload the per-season stats (both editor-seeded) once signed in.
    if (window.HCCL && typeof window.HCCL.onChange === "function") {
      window.HCCL.onChange(() => { startHomeSync(); seedSeasonStats(); startSeasonLiveSync(); });
    }
    render();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
