/* ============================================================
   HCCL Season Archive  (window.HCCLSeasonArchive)

   The HC Champions League's season-by-season record: a row of
   season tabs (Season 01 … 06); each season shows its honors
   podium (MVP / Champion / Runner-up bubbles + Most Runs / Most
   Wickets), an IPL-style playoffs bracket, and three detailed
   leaderboards (Overall / Batting / Bowling) built from the
   bundled per-season stats CSVs (window.HCCL_SEASON_STATS,
   season-stats-data.js).

   This used to be the Home page body; it is now a MOUNTABLE
   module. The Series tab mounts it inside the HCCL tournament
   hub (series.js), and home.js queries it (seasons/leaders/
   podiumHtml) for the champions carousel. One mount at a time:
   mount(el) unmounts any previous mount first.

   The SEASONS array below is the honors seed + offline fallback;
   when signed in, the same honors are read from Firestore
   (home/seasons) so they stay consistent across devices - "seed
   once, read-only". The leaderboard stats
   are always the bundled CSVs (plus a live CSV override for the
   ongoing season). No dependencies beyond the DOM.
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
        q1:    { a: "WIZARD TITANS", b: "ZYCO KINGS", winner: "ZYCO KINGS" },
        elim:  { a: "MIND GAMERS", b: "SUPER FIRE DRAGONS", winner: "SUPER FIRE DRAGONS" },
        q2:    { winner: "WIZARD TITANS" },
        final: { winner: "ZYCO KINGS" },
      } },
    { no: 3, year: "JAN 2026", champion: "MIND GAMERS", runnerUp: "INVINCIBLE LORDS", mvp: "THENU PABEESHA", mostRuns: "THENU PABEESHA", mostWickets: "UDARA PERERA",
      playoffs: {
        q1:    { a: "MIND GAMERS", b: "WIZARD TITANS", winner: "MIND GAMERS" },
        elim:  { a: "MATRIX", b: "INVINCIBLE LORDS", winner: "INVINCIBLE LORDS" },
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
        q1:    { a: "MIND GAMERS", b: "WIZARD TITANS", winner: "WIZARD TITANS" },
        elim:  { a: "MATRIX", b: "SUPER FIRE DRAGONS", winner: "SUPER FIRE DRAGONS" },
        q2:    { winner: "SUPER FIRE DRAGONS" },
        final: { winner: "SUPER FIRE DRAGONS" },
      } },
    // Ongoing: fill slots in as they're decided. "" (or "TBD") renders a TBD
    // placeholder, so a partly-known bracket is fine - name teams as they qualify.
    { no: 6, year: "JUN 2026 - JUL 2026", champion: "VELOCITY REAPERS", runnerUp: "INVINCIBLE LORDS", mvp: "CHAMIKA KAUSHILA", mostRuns: "ISUKA THISEN", mostWickets: "CHAMIKA KAUSHILA",
      playoffs: {
        q1:    { a: "VELOCITY REAPERS", b: "INVINCIBLE LORDS", winner: "VELOCITY REAPERS" },
        elim:  { a: "SILENTEARZ", b: "SUPER FIRE DRAGONS", winner: "SILENTEARZ" },
        q2:    { winner: "INVINCIBLE LORDS" },
        final: { winner: "VELOCITY REAPERS" },
      } },
    { no: 7, year: "SEP 2026 - OCT 2026", champion: "MATRIX", runnerUp: "SUPER FIRE DRAGONS", mvp: "PASINDU DILSHAN", mostRuns: "SADISHA LAKDUL", mostWickets: "PASINDU DILSHAN",
      playoffs: {
        q1:    { a: "MATRIX", b: "SUPER FIRE DRAGONS", winner: "MATRIX" },
        elim:  { a: "INVINCIBLE LORDS", b: "WIZARD TITANS", winner: "INVINCIBLE LORDS" },
        q2:    { winner: "SUPER FIRE DRAGONS" },
        final: { winner: "MATRIX" },
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
  const baseSeasons = () => (cloudSeasons && cloudSeasons.length) ? cloudSeasons : SEASONS;

  /* ---------- the Series registry decides who is LIVE ---------- */
  // A season is "ongoing" while its entry in the Series tab says `live`, and it
  // is CROWNED the moment an admin fills that entry's Champion / Runner-up /
  // MVP in (Series -> the season -> ✎ Edit -> Status: Completed + Honors).
  // That's a cloud edit any admin can make from the phone - no redeploy - and
  // it drives the LIVE badges, the Home carousel and the bracket below.
  // The `ongoing` / honors values authored in SEASONS are the offline default,
  // used until the registry is readable.
  function seriesMeta(no) {
    const S = window.HCCLSeries;
    if (!S || !S.ready || typeof S.list !== "function") return null;
    return S.list().find(t => (t.season || (t.legacy ? 6 : 0)) === no) || null;
  }

  // Bracket team names are authored UPPERCASE; an admin types "Velocity Reapers".
  // Resolve a typed name to the spelling already in the bracket, because the
  // winner ticks and the hover trace match team names by exact string.
  function canonicalTeam(name, s) {
    const t = String(name || "").trim();
    const p = s && s.playoffs;
    if (!t || !p) return t;
    const pool = [];
    ["q1", "elim"].forEach(k => { if (p[k]) pool.push(p[k].a, p[k].b); });
    return pool.find(x => x && String(x).trim().toLowerCase() === t.toLowerCase()) || t;
  }

  function withRegistry(s) {
    const m = seriesMeta(s.no);
    if (!m) return s;
    const h = m.honors || {};
    const out = { ...s, ongoing: m.status === "live" };
    if (h.champion) out.champion = canonicalTeam(h.champion, s);
    if (h.runnerUp) out.runnerUp = canonicalTeam(h.runnerUp, s);
    if (h.mvp) out.mvp = h.mvp;
    // Naming a champion also settles the bracket: the two finalists ARE the
    // champion and the runner-up, and Qualifier 1's winner is already one of
    // them - so the other one is who came through Qualifier 2.
    const p = out.playoffs;
    if (p && p.q1 && out.champion && out.runnerUp && !(p.final && p.final.winner)) {
      const q1w = String(p.q1.winner || "").toLowerCase();
      const other = [out.champion, out.runnerUp].find(t => String(t).toLowerCase() !== q1w) || "";
      out.playoffs = {
        ...p,
        q2: { ...(p.q2 || {}), winner: (p.q2 && p.q2.winner) || other },
        final: { ...(p.final || {}), winner: out.champion },
      };
    }
    return out;
  }
  const getSeasons = () => baseSeasons().map(withRegistry);

  // Active season tab (season number). Defaults to the ongoing season, else the last.
  let activeSeason = (SEASONS.find(s => s.ongoing) || SEASONS[SEASONS.length - 1]).no;
  // Active leaderboard sub-tab within a season: "overall" | "batting" | "bowling".
  let activeBoard = "overall";

  /* ---------- bubble helpers (team logos / player photos) ---------- */
  const BUBBLE_COLORS = ["#60A5FA", "#2DD4BF", "#F5BD4F", "#A78BFA", "#F472B6", "#38BDF8", "#34D399", "#FB923C"];
  function bubbleColor(s) {
    let h = 0; s = String(s || "");
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return BUBBLE_COLORS[Math.abs(h) % BUBBLE_COLORS.length];
  }
  const firstInitial = s => { const t = String(s || "").trim(); return t && t !== "" ? t[0].toUpperCase() : "?"; };

  // Every image lookup comes from js/asset-manifest.js, which tools/gen-assets.js
  // GENERATES from the real files in assets/. Adding a player photo or a team
  // badge therefore needs no code change - drop the file in and re-run
  // `node tools/gen-assets.js`. (Hand-maintained lists are what silently rotted
  // every player photo into a 404 when the extensions changed.)
  // All indexes are keyed by the LOWERCASED file basename and hold a full path,
  // so a name matches regardless of case. Missing manifest -> empty indexes,
  // which degrade gracefully to the coloured-initial bubbles.
  const AM = (typeof window !== "undefined" && window.HCCL_ASSETS) || {};
  const TEAM_LOGO_INDEX = AM.teamLogoIndex || {};
  const PLAYER_PHOTO_INDEX = AM.playerPhotoIndex || {};
  const SEASON_LOGO_INDEX = AM.seasonLogos || {};
  const TOURNAMENT_LOGO_INDEX = AM.tournamentLogoIndex || {};
  // Tournament badges whose FILE name can't be matched to the registry name even
  // loosely (see logoCanon below - "S01"/"S1", "Crest", "Cricket" etc. need no entry).
  const TOURNAMENT_LOGO_ALIASES = {
    "hc mini ipl 2026": "hc mini ipl s1",
  };
  // Encode so the spaces in folder/file names survive inside url()/href.
  const assetUrl = p => encodeURI(p);
  const keyOf = s => String(s || "").trim().toLowerCase();

  function teamLogo(team) {
    const p = TEAM_LOGO_INDEX[keyOf(team)];
    return p ? assetUrl(p) : "";
  }
  // The permanent cloud library first (an admin's deliberate choice, and the
  // only home for players added since the last manifest regen), then the
  // bundled file. A data URL must not go through encodeURI.
  function playerPhoto(name) {
    const L = (typeof window !== "undefined") && window.HCCLPhotoLib;
    const lib = L ? L.fromLibrary(name) : "";
    if (lib) return lib;
    const p = PLAYER_PHOTO_INDEX[keyOf(name)];
    return p ? assetUrl(p) : "";
  }
  function seasonLogo(no) {
    const p = SEASON_LOGO_INDEX[no];
    return p ? assetUrl(p) : "";
  }
  /* Badge files get renamed ("Solo Knockout S1" -> "Solo Knockout Cricket
     Championship S1", "... League S1" -> "... League Crest"), so names are
     compared loosely: case, "S01"/"Season 1"/"S1", "four"/"4", and filler
     words like HC / Cricket / Crest / Emblem / Logo don't matter. */
  const LOGO_FILLER = /\b(hc|cricket|logo|crest|emblem|badge|the)\b/g;
  function logoCanon(s) {
    return keyOf(s)
      .replace(/\bs(?:eason)?\s*0*(\d+)\b/g, "s$1")
      .replace(/\bfour\b/g, "4")
      .replace(LOGO_FILLER, " ")
      .replace(/[^a-z0-9 ]+/g, " ")
      .replace(/\s+/g, " ").trim();
  }
  const SEASON_TAG = /\bs\d+\b/;
  const squash = s => s.replace(/\s+/g, " ").trim();
  const noSeason = c => squash(c.replace(/\bs\d+\b/g, " "));
  const noGeneric = c => squash(c.replace(/\b(championship|league|tournament|series|cup)\b/g, " "));
  // exact: canonical name -> file. A badge WITHOUT a season tag is the
  // tournament's generic emblem, so it also answers for any season of it
  // (bare) and for a differently-worded title (loose). A season-tagged badge
  // never stands in for another season.
  const LOGO_TIERS = { exact: {}, bare: {}, loose: {} };
  Object.keys(TOURNAMENT_LOGO_INDEX).forEach(k => {
    const c = logoCanon(k);
    if (!(c in LOGO_TIERS.exact)) LOGO_TIERS.exact[c] = k;
    if (SEASON_TAG.test(c)) return;
    if (!(c in LOGO_TIERS.bare)) LOGO_TIERS.bare[c] = k;
    const g = noGeneric(c);
    if (g && !(g in LOGO_TIERS.loose)) LOGO_TIERS.loose[g] = k;
  });
  function tournamentLogo(name) {
    const k = keyOf(name), c = logoCanon(name);
    if (!c) return "";
    const alias = TOURNAMENT_LOGO_ALIASES[k];
    const hit = (alias && TOURNAMENT_LOGO_INDEX[alias] && alias)
      || (TOURNAMENT_LOGO_INDEX[k] && k)
      || LOGO_TIERS.exact[c] || LOGO_TIERS.bare[noSeason(c)] || LOGO_TIERS.loose[noGeneric(noSeason(c))];
    return hit ? assetUrl(TOURNAMENT_LOGO_INDEX[hit]) : "";
  }

  /* A logo saved on a registry entry is an admin upload (data URL) or a bundled
     path a seed wrote. If that bundled file has since been renamed or removed,
     ignore the stale path and find the badge by season / name instead -
     otherwise a rename leaves a broken image that never falls back. */
  const KNOWN_ASSETS = new Set();
  (function collect(o) {
    Object.values(o || {}).forEach(v => { if (typeof v === "string") KNOWN_ASSETS.add(v); else if (v && typeof v === "object") collect(v); });
  })({ a: AM.playerPhotoIndex, b: AM.teamLogoFolders, c: AM.teamLogoIndex, d: AM.seasonLogos, e: AM.tournamentLogoIndex });
  // original "assets/..." path -> its lightweight assets-web copy (tools/optimize-images.js)
  const WEB_MAP = AM.webMap || {};
  function logoFor(stored, name, seasonNo) {
    const s = String(stored || "");
    let p = s;
    try { p = decodeURI(s); } catch (e) { /* not URI-encoded */ }
    if (WEB_MAP[p]) return assetUrl(WEB_MAP[p]);
    const stale = KNOWN_ASSETS.size > 0 && /^assets\//i.test(p) && !KNOWN_ASSETS.has(p);
    if (s && !stale) return s;
    return (seasonNo ? seasonLogo(seasonNo) : "") || tournamentLogo(name);
  }
  // A round bubble: team logo / player photo if known, else a colored initial.
  function bubble(kind, value) {
    const img = kind === "team" ? teamLogo(value) : playerPhoto(value);
    return img
      ? `<span class="bubble" style="background-image:url('${img}')"></span>`
      : `<span class="bubble fallback" style="background:${bubbleColor(value)}">${esc(firstInitial(value))}</span>`;
  }

  // A real player name (not a placeholder) opens that player's Hall of Fame
  // profile when tapped (js/hall-of-fame.js listens for [data-player]).
  const PLACEHOLDER = /^(|tbd|tba|-+|\?|n\/a)$/i;
  const playerAttr = name => (PLACEHOLDER.test(String(name || "").trim()) ? ""
    : ` data-player="${esc(String(name).trim())}" role="button" tabindex="0"`);
  function podiumItem(cls, role, kind, value) {
    return `<div class="podium-item ${cls}"${kind === "player" ? playerAttr(value) : ""}>
      ${bubble(kind, value)}
      <span class="podium-role">${role}</span>
      <span class="podium-name">${esc(value)}</span>
    </div>`;
  }
  // `icon` may be a legacy emoji (🏏 / 🎯) or a Lucide name; both render as
  // the matching Lucide icon so every caller gets the same look.
  const EXTRA_ICONS = { "🏏": "zap", "🎯": "target" };
  function extraIcon(icon) {
    const name = EXTRA_ICONS[icon] || icon;
    return window.HCCLUI && /^[a-z0-9-]+$/.test(name || "") ? window.HCCLUI.icon(name, "sm") : esc(icon || "");
  }
  function extraItem(icon, label, name) {
    return `<div class="extra-item"${playerAttr(name)}>
      ${bubble("player", name)}
      <div class="extra-meta">
        <span class="extra-label">${extraIcon(icon)} ${label}</span>
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
  const UNKNOWN_TEAM = new Set(["", "TBD", "TBA", "-", "--", "", "?", "N/A"]);
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
    const root = mountEl && mountEl.querySelector(".pl-bracket");
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
    const root = mountEl && mountEl.querySelector(".pl-bracket");
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
    // RAW columns - the career aggregate sums these and re-derives avg/SR/econ.
    // You cannot average the per-sheet batAvg/batSR/econ columns and get the
    // right answer; you need the underlying balls/innings/outs/runs conceded.
    batInn: 5, ballsFaced: 15, notOuts: 16, bowlInn: 21, runsConceded: 23, ballsBowled: 31,
  };
  // Header spot-checks used to validate an imported Season Stats CSV against
  // the same fixed 36-column layout the COL map above assumes.
  const SEASON_CSV_HEADER_CHECKS = [
    [0, /^no\.?$/i], [1, /player name/i], [2, /team name/i],
    [6, /runs scored/i], [22, /^wickets$/i], [30, /best bowl/i],
  ];

  // Per-season CSV text published by an editor (Firestore seasonStatsLive/S#),
  // keyed by season number. Wins over the bundled window.HCCL_SEASON_STATS when
  // present - see seasonRows() below.
  const liveCsvBySeason = {};
  let liveUnsub = null;    // unsubscribe fn for the seasonStatsLive listener

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
  const bbf = v => { const t = String(v || "").trim(); return (!t || t === "0") ? "" : t; };
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
      { label: "Player", cell: r => `<span class="lb-player player-link"${playerAttr(r[COL.name])}>${esc(r[COL.name])}</span>` },
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
      { label: "Player", cell: r => `<span class="lb-player player-link"${playerAttr(r[COL.name])}>${esc(r[COL.name])}</span>` },
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
      { label: "Player", cell: r => `<span class="lb-player player-link"${playerAttr(r[COL.name])}>${esc(r[COL.name])}</span>` },
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
  // Where the archive is currently mounted (a container element supplied by the
  // host view - the Series tournament hub), or null while unmounted. Firestore
  // sync keeps running either way; render() just no-ops without a mount.
  let mountEl = null;
  // Season number the mount is pinned to (per-season tournament hub), or null
  // for the full archive with its row of season tabs.
  let pinnedSeason = null;
  // Data-change subscribers (home.js rebuilds the champions carousel from these).
  const listeners = [];
  function emit() {
    listeners.forEach(cb => { try { cb(api); } catch (e) { console.error(e); } });
  }

  function seasonTabsHtml(list) {
    return list.map(s =>
      `<button class="season-tab${s.no === activeSeason ? " active" : ""}" data-season="${s.no}">
        Season ${pad2(s.no)}${s.ongoing ? `<span class="season-tab-live">LIVE</span>` : ""}
      </button>`).join("");
  }

  function seasonPanelHtml(s) {
    const rows = seasonRows(s.no);
    // Derived from this season's stats sheet, so importing a new CSV for the
    // ongoing season re-crowns these automatically. The authored SEASONS values
    // are only a fallback for a season with no sheet (or no runs/wickets yet).
    const mostRuns = seasonLeader(rows, byRuns, COL.runs) || s.mostRuns || "";
    const mostWickets = seasonLeader(rows, byWickets, COL.wickets) || s.mostWickets || "";
    return `
      <article class="season-card">
        <div class="season-card-head">
          ${seasonBadge(s)}
          <div class="season-meta">
            <h3>Season ${pad2(s.no)}</h3>
            <span class="season-year">${esc(s.year)}${s.ongoing ? ` · <span class="season-live">ONGOING</span>` : ""}</span>
          </div>
        </div>
        ${playoffsHtml(s)}
        <div class="season-extra">
          ${extraItem("🏏", "Most Runs", mostRuns)}
          ${extraItem("🎯", "Most Wickets", mostWickets)}
        </div>
        <div class="season-boards">
          <div class="season-boards-head">
            <h3 class="season-boards-title">Season ${pad2(s.no)} · Player Stats</h3>
            <label class="btn btn-yellow file-btn season-stats-import" title="Upload the Season ${pad2(s.no)} stats CSV - updates the leaderboard for everyone (raw STUMPS exports are fine)">
              ${window.HCCLUI ? window.HCCLUI.icon("upload") : ""}<span>Import Season Stats</span>
              <input type="file" class="season-stats-import-file" data-season="${s.no}" accept=".csv,text/csv" hidden />
            </label>
          </div>
          <div class="board-tabs" role="tablist">
            ${BOARDS.map(b => `<button class="board-tab${b.key === activeBoard ? " active" : ""}" data-board="${b.key}">${esc(b.label)}</button>`).join("")}
          </div>
          <div class="board-panel">
            ${boardPanelHtml(rows)}
          </div>
        </div>
      </article>`;
  }

  function render() {
    if (!mountEl) return;
    const list = getSeasons();

    // Pinned mount (per-season tournament hub): just that season's panel,
    // no season-tab row. A pinned season with no archive entry yet (an
    // upcoming season) gets a friendly placeholder instead.
    if (pinnedSeason != null) {
      const s = list.find(x => x.no === pinnedSeason);
      mountEl.innerHTML = `
        <section class="home-seasons">
          <div class="season-panel">
            ${s ? seasonPanelHtml(s) : `
            <article class="season-card">
              <div class="season-card-head">
                <div class="season-no">S${pad2(pinnedSeason)}</div>
                <div class="season-meta">
                  <h3>Season ${pad2(pinnedSeason)}</h3>
                  <span class="season-year">COMING SOON</span>
                </div>
              </div>
              <p class="hint">This season hasn't started yet - fixtures, playoffs and stats will appear here once it's under way.</p>
            </article>`}
          </div>
        </section>`;
      requestAnimationFrame(drawBracketLines);
      return;
    }

    // Keep the active season in range if the honors list changes (cloud copy).
    if (!list.some(s => s.no === activeSeason)) activeSeason = list.length ? list[list.length - 1].no : 1;
    const active = list.find(s => s.no === activeSeason) || list[0];

    mountEl.innerHTML = `
      <section class="home-seasons">
        <nav class="season-tabs">
          ${seasonTabsHtml(list)}
        </nav>
        <div class="season-panel">
          ${active ? seasonPanelHtml(active) : ""}
        </div>
      </section>`;
    // Connectors need the boxes laid out first; measure on the next frame.
    requestAnimationFrame(drawBracketLines);
    // On phones the season pills are a swipeable row - keep the selected
    // season in view (scrollLeft only, so the page itself never jumps).
    const bar = mountEl.querySelector(".season-tabs");
    const act = bar && bar.querySelector(".season-tab.active");
    if (bar && act && bar.scrollWidth > bar.clientWidth) {
      bar.scrollLeft = Math.max(0, act.offsetLeft - (bar.clientWidth - act.offsetWidth) / 2);
    }
  }

  function onClick(e) {
    // Leaderboard sub-tab: swap only the board panel so the page doesn't jump.
    const board = e.target.closest("[data-board]");
    if (board) {
      const key = board.getAttribute("data-board");
      if (key === activeBoard) return;
      activeBoard = key;
      const s = getSeasons().find(x => x.no === activeSeason);
      const panel = mountEl && mountEl.querySelector(".board-panel");
      if (panel && s) panel.innerHTML = boardPanelHtml(seasonRows(s.no));
      if (mountEl) mountEl.querySelectorAll(".board-tab").forEach(t =>
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
    const panel = mountEl && mountEl.querySelector(".season-panel");
    if (panel && panel.scrollIntoView) panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function onFileChange(e) {
    const inp = e.target.closest(".season-stats-import-file");
    if (inp && inp.files && inp.files[0]) {
      const no = parseInt(inp.getAttribute("data-season"), 10);
      if (no) importSeasonCsv(inp.files[0], no);
      inp.value = "";
    }
  }

  const onMouseLeave = () => traceTeam("");

  // mount(el) -> full archive with season tabs; mount(el, 3) -> pinned to
  // Season 03 only (the per-season tournament hubs use this form).
  function mount(el, seasonNo) {
    if (!el) return;
    const pin = seasonNo == null ? null : seasonNo;
    if (el === mountEl && pin === pinnedSeason) { render(); return; }
    unmount();
    mountEl = el;
    pinnedSeason = pin;
    el.addEventListener("click", onClick);
    el.addEventListener("change", onFileChange);
    // Playoffs bracket: trace a team's path on hover, and drop the trace when
    // the pointer leaves the mount entirely (mouseover alone never fires then).
    el.addEventListener("mouseover", onBracketHover);
    el.addEventListener("mouseleave", onMouseLeave);
    render();
  }

  function unmount() {
    if (!mountEl) return;
    mountEl.removeEventListener("click", onClick);
    mountEl.removeEventListener("change", onFileChange);
    mountEl.removeEventListener("mouseover", onBracketHover);
    mountEl.removeEventListener("mouseleave", onMouseLeave);
    mountEl = null;
    pinnedSeason = null;
  }

  /* ---------------- Firestore: read cloud honors + editor seed --------------- */
  // "Seed once, read-only": everyone reads home/seasons; an
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
        emit();
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

  /* ------ Firestore: published season stats sheets (seasonStatsLive/S#) ------ */
  // "Store raw CSV, recompute client-side":
  // an editor imports a Season Stats CSV; it's published as-is to
  // seasonStatsLive/S{no}; every signed-in client's onSnapshot listener picks
  // it up and seasonRows() prefers it over the bundled CSV for that season.
  //
  // The listener follows the WHOLE collection, not just the ongoing season: the
  // sheet an editor publishes on finals night has to keep rendering after the
  // season is marked completed. (The bundled CSVs are only as fresh as the last
  // deploy, so dropping the published one on season end would silently roll the
  // leaderboards back.)
  function notify(msg, kind) {
    if (typeof window.toast === "function") window.toast(msg, kind);
    else console.log("[season-archive]", msg);
  }

  // Validate an uploaded CSV against the fixed 36-column Season Stats layout
  // the COL map assumes. Every leaderboard cell is looked up by position, so a
  // wrong-shaped file must be rejected outright rather than silently accepted -
  // an accepted mismatch would corrupt every stat cell with no visible sign.
  // Quote-aware CSV -> grid of cells. Owned here since the ranking module that
  // used to provide it was retired: a validator that silently fails to parse
  // would reject every legitimate sheet, so this must never depend on another
  // module being loaded. Handles quoted fields, escaped "" and CRLF.
  function parseCsvGrid(text) {
    const rows = [];
    let field = "", row = [], inQ = false;
    text = String(text).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQ = false;
        } else field += c;
      } else if (c === '"') inQ = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else field += c;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function validateSeasonCsv(text) {
    let grid = [];
    try { grid = parseCsvGrid(text); } catch (e) { grid = null; }
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
    if (liveUnsub || !H || !H.configured || !H.user || !H.db || !H.fs) return;
    const fs = H.fs;
    if (!fs.collection || !fs.onSnapshot) return;
    liveUnsub = fs.onSnapshot(fs.collection(H.db, "seasonStatsLive"), snap => {
      // Rebuilt from scratch each snapshot, so a DELETED sheet correctly falls
      // back to the bundled CSV instead of lingering.
      Object.keys(liveCsvBySeason).forEach(no => {
        delete liveCsvBySeason[no];
        delete seasonRowsCache[no]; // invalidate BEFORE render() recomputes
      });
      snap.forEach(d => {
        const data = d.data() || {};
        const no = parseInt(data.season || String(d.id).replace(/^S/i, ""), 10);
        const csv = (typeof data.csv === "string" && data.csv.trim()) ? data.csv : "";
        if (!no || !csv) return;
        liveCsvBySeason[no] = csv;
        delete seasonRowsCache[no];
      });
      render();
      emit();
    }, err => console.error("season stats snapshot error:", err));
  }

  // Editor-only: publish an uploaded Season Stats CSV so it updates that
  // season's leaderboard for everyone (or apply locally when offline). Allowed
  // for ANY season - the ongoing one gets a fresh sheet after every match day,
  // and a finished one can still be corrected.
  async function importSeasonCsv(file, seasonNo) {
    if (!file || !seasonNo) return;
    const H = window.HCCL;
    let text = "";
    try { text = await file.text(); } catch (e) { notify("Couldn't read that file.", "bad"); return; }
    text = api.normalizeSheet(text); // tolerate raw STUMPS exports (preamble rows)
    const check = validateSeasonCsv(text);
    if (!check.ok) { notify(check.reason, "bad"); return; }

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
    liveCsvBySeason[seasonNo] = text; delete seasonRowsCache[seasonNo]; render(); emit();
    notify(`Season ${pad2(seasonNo)} stats imported - ${check.playerCount} players (this device only).`, "good");
  }

  /* ---------------- public API ---------------- */
  const api = {
    mount, unmount,
    // The honors list (cloud copy when fresh, else the bundled seed).
    seasons: () => getSeasons().slice(),
    ongoing: () => getSeasons().find(s => s.ongoing) || null,
    // Most Runs / Most Wickets for a season - derived from its stats sheet
    // (incl. the live CSV override), falling back to the authored honors.
    leaders(no) {
      const s = getSeasons().find(x => x.no === no) || {};
      const rows = seasonRows(no);
      return {
        mostRuns: seasonLeader(rows, byRuns, COL.runs) || s.mostRuns || "",
        mostWickets: seasonLeader(rows, byWickets, COL.wickets) || s.mostWickets || "",
      };
    },
    // Champion / Runner-up / MVP podium for any honors-shaped object.
    // `champKind` is "team" (default) or "player" - solo tournaments crown a
    // player, so their champion/runner-up bubbles resolve player photos.
    podiumHtml(h, champKind) {
      h = h || {};
      const kind = champKind === "player" ? "player" : "team";
      return `<div class="podium">
        ${podiumItem("mvp", "MVP", "player", h.mvp || "")}
        ${podiumItem("champion", "Champion", kind, h.champion || "")}
        ${podiumItem("runner", "Runner-up", kind, h.runnerUp || "")}
      </div>`;
    },
    extraItem, bubble, seasonLogo, tournamentLogo, logoFor, teamLogo, playerPhoto,
    /* ---- reusable stats-sheet machinery (per-tournament sheets in series.js) ---- */
    // Raw STUMPS exports carry a few preamble rows (app title, tournament
    // name, tour id) before the real header - drop everything above it so
    // both the bundled sheets and hand-uploaded exports parse the same way.
    normalizeSheet(text) {
      const lines = String(text || "").split(/\r?\n/);
      const idx = lines.findIndex(l => /^no\.?\s*,\s*player name/i.test(l.trim()));
      return idx > 0 ? lines.slice(idx).join("\n") : String(text || "");
    },
    // Parse a Season-Stats-format CSV into cell rows (header dropped) - the
    // same naive split the bundled season sheets use.
    rowsFromCsv(text) {
      return api.normalizeSheet(text).split(/\r?\n/)
        .map(l => l.trim()).filter(Boolean).slice(1)
        .map(line => line.split(",").map(c => c.trim()));
    },
    // Strict 36-column layout check - returns { ok, reason?, playerCount? }.
    validateCsv: text => validateSeasonCsv(api.normalizeSheet(text)),
    // Bundled per-tournament sheet (js/tournament-stats-data.js), matched by
    // registry id first, then case-insensitive tournament name.
    tournamentCsv(id, name) {
      const store = window.HCCL_TOURNAMENT_STATS || [];
      const norm = s => String(s || "").trim().toLowerCase();
      const hit = store.find(x => x.id === id || (name && norm(x.name) === norm(name)));
      return hit ? hit.csv : null;
    },
    // One leaderboard table (key: "overall" | "batting" | "bowling").
    boardHtml(rows, key) {
      const b = BOARDS.find(x => x.key === key) || BOARDS[0];
      return b.build(rows);
    },
    boardKeys: () => BOARDS.map(b => ({ key: b.key, label: b.label })),
    // Top run-scorer / wicket-taker of a sheet ("" until someone scores).
    leadersFromRows(rows) {
      return {
        mostRuns: seasonLeader(rows, byRuns, COL.runs),
        mostWickets: seasonLeader(rows, byWickets, COL.wickets),
      };
    },
    // Bundled per-season CSV rows (S1-S6), used by the tournament page to build
    // squads/players for an HCCL season straight from its sheet.
    seasonRows(no) { return seasonRows(no); },
    // One flat player list from stat rows: { name, team, matches, runs, wickets }.
    // The Team column (COL.team) is what makes CSV-only tournaments show squads.
    playersFromRows(rows) {
      return (rows || []).filter(r => (r[COL.name] || "").trim()).map(r => ({
        name: r[COL.name] || "", team: r[COL.team] || "",
        matches: r[COL.matches] || "", runs: r[COL.runs] || "", wickets: r[COL.wickets] || "",
      }));
    },
    // The same players grouped into squads: [{ team, logo, players:[...] }],
    // teams in first-seen order. Players with no team fall under "Unassigned".
    squadsFromRows(rows) {
      const groups = [];
      const byTeam = new Map();
      api.playersFromRows(rows).forEach(p => {
        const key = (p.team || "Unassigned").trim() || "Unassigned";
        if (!byTeam.has(key)) { const g = { team: key, logo: teamLogo(key) || "", players: [] }; byTeam.set(key, g); groups.push(g); }
        byTeam.get(key).players.push(p);
      });
      return groups;
    },
    /* ---------- career stats across every sheet ----------
       Used by the auction Setup form to pre-fill a player's card. Sums the RAW
       columns from every sheet the player appears in, then RE-DERIVES average /
       strike rate / economy. Averaging the per-sheet batAvg/batSR/econ columns
       would be wrong - a 5-run season and a 500-run season would count equally.

       `extraSheets` lets the caller fold in CSVs the archive can't see by itself
       (cloud-imported tournament sheets); results are cached per sheet set. */
    careerIndex(extraSheets) {
      const sheets = [];
      // bundled per-season sheets (+ any live override) …
      getSeasons().forEach(s => { const r = seasonRows(s.no); if (r && r.length) sheets.push({ name: `HCCL Season ${pad2(s.no)}`, rows: r }); });
      // … the bundled per-tournament sheets …
      // A cloud import of the SAME tournament supersedes its bundled copy, so
      // a player's runs are counted once, not twice. Matched by registry id,
      // or by the loose name canon (so "Mini IPL 2026" == "HC Mini IPL 2026").
      // Twin registry entries can each carry an import of the same event -
      // keep one per tournament (same canon name or identical sheet text).
      const seenExtra = new Set();
      const extras = (extraSheets || []).filter(x => {
        if (!x || !x.csv) return false;
        const canon = logoCanon(x.name || "");
        const k1 = canon ? "n:" + canon : "", k2 = "c:" + x.csv;
        if ((k1 && seenExtra.has(k1)) || seenExtra.has(k2)) return false;
        if (k1) seenExtra.add(k1);
        seenExtra.add(k2);
        return true;
      });
      const extraIds = new Set(extras.map(x => x.id).filter(Boolean));
      const extraNames = new Set(extras.map(x => logoCanon(x.name)).filter(Boolean));
      (window.HCCL_TOURNAMENT_STATS || []).forEach(t => {
        if (!t || !t.csv) return;
        if ((t.id && extraIds.has(t.id)) || (t.name && extraNames.has(logoCanon(t.name)))) return;
        sheets.push({ name: t.name || t.id || "Tournament", rows: api.rowsFromCsv(t.csv) });
      });
      // … and anything the caller supplies ({ id?, name, csv }).
      extras.forEach(x => {
        sheets.push({ name: x.name || "Tournament", rows: api.rowsFromCsv(x.csv) });
      });

      const key = n => String(n || "").trim().toLowerCase().replace(/\s+/g, " ");
      const idx = new Map();
      sheets.forEach(sheet => {
        (sheet.rows || []).forEach(r => {
          const nm = (r[COL.name] || "").trim();
          if (!nm) return;
          const k = key(nm);
          let a = idx.get(k);
          if (!a) {
            a = { name: nm, tournaments: [], matches: 0, runs: 0, batInn: 0, ballsFaced: 0,
                  notOuts: 0, wickets: 0, runsConceded: 0, ballsBowled: 0 };
            idx.set(k, a);
          }
          if (a.tournaments.indexOf(sheet.name) === -1) a.tournaments.push(sheet.name);
          a.matches      += num(r[COL.matches]);
          a.runs         += num(r[COL.runs]);
          a.batInn       += num(r[COL.batInn]);
          a.ballsFaced   += num(r[COL.ballsFaced]);
          a.notOuts      += num(r[COL.notOuts]);
          a.wickets      += num(r[COL.wickets]);
          a.runsConceded += num(r[COL.runsConceded]);
          a.ballsBowled  += num(r[COL.ballsBowled]);
        });
      });
      return idx;
    },
    /* One player's career line, or null when no sheet mentions them.
       Rounded to what the player card shows. */
    careerStatsFor(name, extraSheets) {
      const key = n => String(n || "").trim().toLowerCase().replace(/\s+/g, " ");
      const a = api.careerIndex(extraSheets).get(key(name));
      if (!a || !a.tournaments.length) return null;
      const round1 = v => Math.round(v * 10) / 10;
      const outs = a.batInn - a.notOuts;              // dismissals
      const overs = a.ballsBowled / 6;
      return {
        name: a.name,
        tournaments: a.tournaments.slice(),
        matches: a.matches,
        runs: a.runs,
        wickets: a.wickets,
        // Guarded: a batter never dismissed has no average; no balls -> no SR.
        average:    outs > 0 ? round1(a.runs / outs) : (a.runs > 0 ? round1(a.runs) : 0),
        strikeRate: a.ballsFaced > 0 ? round1((a.runs / a.ballsFaced) * 100) : 0,
        economy:    overs > 0 ? round1(a.runsConceded / overs) : 0,
      };
    },
    /* ---------- Hall of Fame / player profiles ----------
       statLines(sheets): sheets = [{ id, name, rows }] - ONE sheet per
       tournament (the caller picks the effective one: cloud import, else the
       bundled copy), so nothing is ever counted twice. Returns a Map
       key -> { name, lines: [{ id, tournament, team, matches, runs, wickets,
       batInn, ballsFaced, notOuts, runsConceded, ballsBowled }] }. */
    statLines(sheets) {
      const key = n => String(n || "").trim().toLowerCase().replace(/\s+/g, " ");
      const idx = new Map();
      (sheets || []).forEach(sheet => {
        (sheet.rows || []).forEach(r => {
          const nm = (r[COL.name] || "").trim();
          if (!nm) return;
          const k = key(nm);
          if (!idx.has(k)) idx.set(k, { name: nm, lines: [] });
          idx.get(k).lines.push({
            id: sheet.id, tournament: sheet.name, team: (r[COL.team] || "").trim(),
            matches: num(r[COL.matches]), runs: num(r[COL.runs]), wickets: num(r[COL.wickets]),
            batInn: num(r[COL.batInn]), ballsFaced: num(r[COL.ballsFaced]), notOuts: num(r[COL.notOuts]),
            runsConceded: num(r[COL.runsConceded]), ballsBowled: num(r[COL.ballsBowled]),
          });
        });
      });
      return idx;
    },
    // Career line from statLines() lines - the SAME formulas as
    // careerStatsFor() above (guarded average, SR from balls faced, economy
    // per 6-ball over), so a profile and the Setup preview agree.
    careerTotals(lines) {
      const t = { matches: 0, runs: 0, wickets: 0, batInn: 0, ballsFaced: 0, notOuts: 0, runsConceded: 0, ballsBowled: 0 };
      (lines || []).forEach(l => Object.keys(t).forEach(k => { t[k] += l[k] || 0; }));
      const round1 = v => Math.round(v * 10) / 10;
      const outs = t.batInn - t.notOuts;
      const overs = t.ballsBowled / 6;
      return {
        matches: t.matches, runs: t.runs, wickets: t.wickets,
        average:    outs > 0 ? round1(t.runs / outs) : (t.runs > 0 ? round1(t.runs) : 0),
        strikeRate: t.ballsFaced > 0 ? round1((t.runs / t.ballsFaced) * 100) : 0,
        economy:    overs > 0 ? round1(t.runsConceded / overs) : 0,
        bowled: t.ballsBowled > 0, batted: t.batInn > 0 || t.ballsFaced > 0,
      };
    },
    // Fired whenever the underlying data changes (cloud honors, live CSV).
    onChange(cb) { listeners.push(cb); },
  };
  window.HCCLSeasonArchive = api;

  function init() {
    // Connector geometry is measured, so it must be recomputed when the width changes.
    window.addEventListener("resize", () => requestAnimationFrame(drawBracketLines));
    // Read cloud honors + upload the per-season stats (both editor-seeded) once
    // signed in. Sync runs whether or not the archive is currently mounted, so
    // the carousel on Home stays fresh even if nobody opens the Series hub.
    if (window.HCCL && typeof window.HCCL.onChange === "function") {
      window.HCCL.onChange(() => { startHomeSync(); seedSeasonStats(); startSeasonLiveSync(); });
    }
    // The registry owns each season's live/completed status and honors
    // (see withRegistry) - repaint the moment an admin changes them, and let
    // home.js rebuild its carousel off the same event.
    // Library photos land after sign-in: repaint the boards, and emit so Home's
    // carousel (which draws its podium through this module) repaints too.
    document.addEventListener("hccl:photos", () => { render(); emit(); });
    if (window.HCCLSeries && typeof window.HCCLSeries.onChange === "function") {
      window.HCCLSeries.onChange(() => { render(); emit(); });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
