/* ============================================================
   HCCL Player Ranking ENGINE  (data + math only - no UI)

   Consumed by ranking.js (the UI). Exposes window.HCCLRanking:
     onChange(cb)         - subscribe; called (immediately if ready)
                            when rankings are (re)computed
     getRanking(cat)      - "batting" | "bowling" | "allrounder" →
                            { available, updated, rows:[{pos,name,rating}] }
     getStatus()          - { baselineDate, seasonDate, seasonSource }
     importSeasonCSV(txt) - admin/mod: ongoing season's cumulative CSV
     refresh()            - re-fetch the CSVs and recompute

   DATA MODEL - two inputs, two roles:
   1. BASELINE - "HCCL Player Stats/HCCL Statistics.csv" (committed).
      The combined ALL-TIME sheet: one career row per player, S1 → now.
      Drives Career, Achievements, Experience, qualification, confidence.
   2. ONGOING SEASON (optional) - the current season's cumulative sheet,
      same column layout. Drives the FORM component only. Two paths:
        - in-app import (admin/moderator card) → instant on that device;
        - committed as "HCCL Player Stats/Current Season.csv" → fetched
          for everyone (commit the same file you imported to publish it).
      Each update REPLACES the previous one (the sheet is cumulative).
      A manual import takes precedence over the fetched file on that
      device (source: "import").

   WEEKLY FLOW: play match → export ongoing season sheet → import it on
   the Player Ranking page (and/or commit as Current Season.csv). Form
   updates instantly; career moves whenever the combined sheet itself is
   refreshed. SEASON ROLLOVER: regenerate the combined all-time sheet,
   replace HCCL Statistics.csv (and delete/empty Current Season.csv),
   commit. The engine fingerprints the baseline text - when it changes,
   any stored season data is considered folded-in and is cleared
   automatically.

   RATING MODEL - per the "HCCL Batting Rankings Explanation" PDF:
     Rating = 100 + 0.9 × (5×Career + 3×Form + 1×Ach + 1×Exp)
     (each component 0–100; the 0.9 rescale keeps the PDF's 5:3:1:1
     proportions while making the TRUE maximum exactly 1000)
   Career/achievements are normalized against the best QUALIFIED player.
   Form comes from the ongoing season sheet (normalized within it):
     - no season data yet     → form = career score (all-time board)
     - played this season     → form = this season's score
     - absent this season     → form = career score × 0.6 (slides gently)
   A confidence factor shrinks ratings toward the 100 base when a player
   has too few career innings to judge reliably.
   ============================================================ */
(function () {
  "use strict";

  /* ------------------------- configuration ------------------------- */

  const BASELINE_FILE = "HCCL Player Stats/HCCL Statistics.csv"; // all-time combined sheet
  const SEASON_FILE = "HCCL Player Stats/Current Season.csv";    // optional weekly export

  // Qualification for the official lists (per the PDF for batting;
  // bowling mirrors it) - judged on the all-time career totals.
  // Unqualified players still accumulate ratings but are not shown.
  const QUAL = {
    batting: { innings: 10, runs: 100 },
    bowling: { innings: 10, wickets: 10 },
  };

  // Confidence: full trust at this many career innings; below it the
  // rating shrinks toward the 100 base (rating = 100 + conf×(raw−100)).
  const CONF_FULL_INNINGS = 20;

  // Experience score from career innings (PDF table), linearly
  // interpolated between the anchor points.
  const EXP_CURVE = [[0, 0], [10, 10], [20, 20], [30, 40], [40, 70], [50, 100]];

  // Career achievement points (PDF: Thirty +15, Fifty +35, POM +50;
  // hundreds are an extension of the same ladder).
  const ACH_BAT = { t30: 15, t50: 35, t100: 75, pom: 50 };
  const ACH_BOWL = { w3: 35, w5: 75, maiden: 15, pom: 50 };

  // Form for a player who is absent from the ongoing season sheet:
  // their career score scaled by this factor (active players overtake).
  const FORM_FALLBACK_ABSENT = 0.6;

  const KEY_DATA = "hccl_ranking_data_v2";
  const KEY_SNAPSHOT = "hccl_ranking_latest_v2";
  const OLD_KEYS = ["hccl_ranking_history_v1", "hccl_ranking_latest_v1"]; // pre-combined-sheet era

  /* --------------------------- utilities --------------------------- */

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  // "higher is better" ratio vs the pool's best → 0..1
  const ratioHi = (v, best) => (best > 0 ? clamp(v / best, 0, 1) : 0);
  // "lower is better" ratio vs the pool's best (minimum) → 0..1
  const ratioLo = (best, v) => (v > 0 && isFinite(v) && best > 0 ? clamp(best / v, 0, 1) : 0);

  // First number inside a cell ("20*" → 20, " 2-11" → 2, "" → 0).
  function num(v) {
    const m = String(v == null ? "" : v).match(/-?\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : 0;
  }

  // Consistent identity across files: trim, collapse spaces, lowercase.
  const nameKey = s => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
  const displayName = s => String(s || "").trim().replace(/\s+/g, " ");

  function interp(curve, x) {
    if (x <= curve[0][0]) return curve[0][1];
    for (let i = 1; i < curve.length; i++) {
      const [x1, y1] = curve[i - 1], [x2, y2] = curve[i];
      if (x <= x2) return y1 + (y2 - y1) * ((x - x1) / (x2 - x1));
    }
    return curve[curve.length - 1][1];
  }

  // Cheap text fingerprint (djb2) - detects a replaced baseline sheet.
  function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return String(h);
  }

  /* -------------------------- CSV parsing -------------------------- */

  // Minimal RFC-ish CSV: quoted fields, embedded commas/quotes, CRLF.
  function parseCSV(text) {
    const rows = [];
    let row = [], field = "", inQ = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ",") { row.push(field); field = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.some(c => c.trim() !== "")) rows.push(row);
        row = [];
      } else field += ch;
    }
    row.push(field);
    if (row.some(c => c.trim() !== "")) rows.push(row);
    if (!rows.length) return [];
    const header = rows[0].map(h => h.trim());
    return rows.slice(1).map(r => {
      const o = {};
      header.forEach((h, i) => { o[h] = r[i] !== undefined ? r[i] : ""; });
      return o;
    });
  }

  // One CSV row → a normalized player stat line. Works for both the
  // combined all-time sheet and a season sheet (same columns; extras
  // like "Seasons Played" are ignored, missing values become 0).
  function normalizeRow(r) {
    return {
      name: displayName(r["Player Name"]),
      key: nameKey(r["Player Name"]),
      matches: num(r["Matches"]),
      pom: num(r["POM Awards"]),
      bat: {
        inns: num(r["Bat Innings"]), runs: num(r["Runs Scored"]),
        notOuts: num(r["Not Outs"]), balls: num(r["Balls Faced"]),
        t30: num(r["30s"]), t50: num(r["50s"]), t100: num(r["100s"]),
        high: num(r["High Score"]),
      },
      bowl: {
        inns: num(r["Bowl Inn"]), wkts: num(r["Wickets"]),
        conceded: num(r["Runs Conceded"]), balls: num(r["Balls Bowled"]),
        maidens: num(r["Maiden"]), dots: num(r["Dots Bowled"]),
        w3: num(r["3 Wkts"]), w5: num(r["5 Wkts"]),
      },
    };
  }

  function parsePlayersCSV(text) {
    const byKey = new Map();
    parseCSV(text).forEach(raw => {
      const s = normalizeRow(raw);
      if (!s.key) return;
      const prev = byKey.get(s.key);
      if (!prev) { byKey.set(s.key, s); return; }
      // Duplicate row for the same player: merge by summing counting
      // stats, keep maxima where relevant.
      ["matches", "pom"].forEach(k => prev[k] += s[k]);
      Object.keys(prev.bat).forEach(k => { k === "high" ? prev.bat.high = Math.max(prev.bat.high, s.bat.high) : prev.bat[k] += s.bat[k]; });
      Object.keys(prev.bowl).forEach(k => prev.bowl[k] += s.bowl[k]);
    });
    return [...byKey.values()];
  }

  /* ------------------- data store (localStorage) ------------------- */

  const hasStorage = typeof localStorage !== "undefined";
  function loadData() {
    if (!hasStorage) return { baseline: null, season: null };
    try {
      const d = JSON.parse(localStorage.getItem(KEY_DATA));
      return d && typeof d === "object" ? { baseline: d.baseline || null, season: d.season || null } : { baseline: null, season: null };
    } catch (e) { return { baseline: null, season: null }; }
  }
  function saveData(d) {
    if (!hasStorage) return;
    try { localStorage.setItem(KEY_DATA, JSON.stringify(d)); } catch (e) { /* full - data is refetched anyway */ }
  }
  function loadSnapshot() {
    if (!hasStorage) return null;
    try { return JSON.parse(localStorage.getItem(KEY_SNAPSHOT)); } catch (e) { return null; }
  }
  function saveSnapshot(snap) {
    if (!hasStorage) return;
    try { localStorage.setItem(KEY_SNAPSHOT, JSON.stringify(snap)); } catch (e) {}
  }

  /* ------------------------- rating engine ------------------------- */

  // Derived figures (computed from raw totals, not averaged averages).
  const batAvg = b => b.runs / Math.max(1, b.inns - b.notOuts);
  const batSR = b => (b.balls > 0 ? (b.runs / b.balls) * 100 : 0);
  const bowlAvg = b => (b.wkts > 0 ? b.conceded / b.wkts : Infinity);
  const bowlEco = b => (b.balls > 0 ? b.conceded / (b.balls / 6) : Infinity);
  const dotPct = b => (b.balls > 0 ? b.dots / b.balls : 0);

  const batQualified = c => c.bat.inns >= QUAL.batting.innings && c.bat.runs >= QUAL.batting.runs;
  const bowlQualified = c => c.bowl.inns >= QUAL.bowling.innings && c.bowl.wkts >= QUAL.bowling.wickets;

  // Career score (PDF): 50% volume + 30% average + 20% strike rate,
  // each normalized against the best qualified career.
  function careerBatScore(c, P) {
    return 100 * (0.5 * ratioHi(c.bat.runs, P.maxRuns)
                + 0.3 * ratioHi(batAvg(c.bat), P.maxAvg)
                + 0.2 * ratioHi(batSR(c.bat), P.maxSR));
  }
  // Bowling mirrors it: 50% wickets + 25% average + 15% economy + 10% dot%.
  // (Bowling SR is implicit: avg = economy × SR ÷ 6.)
  function careerBowlScore(c, P) {
    return 100 * (0.5 * ratioHi(c.bowl.wkts, P.maxWkts)
                + 0.25 * ratioLo(P.minAvg, bowlAvg(c.bowl))
                + 0.15 * ratioLo(P.minEco, bowlEco(c.bowl))
                + 0.10 * ratioHi(dotPct(c.bowl), P.maxDot));
  }

  // Same shapes applied to an ongoing-season line, normalized within the
  // season sheet itself - this is the live Form component.
  const seasonBatScore = (s, P) => 100 * (0.5 * ratioHi(s.bat.runs, P.maxRuns)
    + 0.3 * ratioHi(batAvg(s.bat), P.maxAvg) + 0.2 * ratioHi(batSR(s.bat), P.maxSR));
  const seasonBowlScore = (s, P) => 100 * (0.5 * ratioHi(s.bowl.wkts, P.maxWkts)
    + 0.25 * ratioLo(P.minAvg, bowlAvg(s.bowl)) + 0.15 * ratioLo(P.minEco, bowlEco(s.bowl))
    + 0.10 * ratioHi(dotPct(s.bowl), P.maxDot));

  const achBatPoints = c => ACH_BAT.t30 * c.bat.t30 + ACH_BAT.t50 * c.bat.t50 + ACH_BAT.t100 * c.bat.t100 + ACH_BAT.pom * c.pom;
  const achBowlPoints = c => ACH_BOWL.w3 * c.bowl.w3 + ACH_BOWL.w5 * c.bowl.w5 + ACH_BOWL.maiden * c.bowl.maidens + ACH_BOWL.pom * c.pom;

  // PDF final formula, rescaled to a TRUE 0-1000 ceiling: the PDF's
  // 100 + 5C + 3F + A + E sums to 1100 at the theoretical max, so the
  // weighted part is scaled by 0.9 (keeping the 5:3:1:1 proportions).
  // A perfect 1000 now needs being the best at literally everything -
  // no player sits on a clamped plateau. The confidence factor shrinks
  // the rating toward the 100 base for thin careers.
  function finalRating(career, form, ach, exp, inns) {
    const raw = 100 + 0.9 * (5 * career + 3 * form + 1 * ach + 1 * exp);
    const conf = clamp(inns / CONF_FULL_INNINGS, 0, 1);
    return clamp(Math.round(100 + conf * (raw - 100)), 0, 1000);
  }

  // Full recalculation → dated ranking snapshot.
  // data = { baseline: { players } | null, season: { players } | null }
  function computeAll(data, dateStr) {
    // Careers come from the combined all-time sheet; if only a season
    // sheet exists (bootstrap edge case), it doubles as the career view.
    const careers = (data.baseline && data.baseline.players && data.baseline.players.length)
      ? data.baseline.players
      : ((data.season && data.season.players) || []);
    if (!careers.length) return { date: dateStr, batting: [], bowling: [], allrounder: [] };

    const seasonPlayers = (data.season && data.season.players) || [];
    const seasonMap = new Map(seasonPlayers.map(p => [p.key, p]));

    const batQ = careers.filter(batQualified);
    const bowlQ = careers.filter(bowlQualified);

    // Career pools - "best qualified player" per the PDF.
    const batPool = {
      maxRuns: Math.max(0, ...batQ.map(c => c.bat.runs)),
      maxAvg: Math.max(0, ...batQ.map(c => batAvg(c.bat))),
      maxSR: Math.max(0, ...batQ.map(c => batSR(c.bat))),
      maxAch: Math.max(0, ...batQ.map(achBatPoints)),
    };
    const finiteMin = arr => { const v = arr.filter(x => isFinite(x) && x > 0); return v.length ? Math.min(...v) : 0; };
    const bowlPool = {
      maxWkts: Math.max(0, ...bowlQ.map(c => c.bowl.wkts)),
      minAvg: finiteMin(bowlQ.map(c => bowlAvg(c.bowl))),
      minEco: finiteMin(bowlQ.map(c => bowlEco(c.bowl))),
      maxDot: Math.max(0, ...bowlQ.map(c => dotPct(c.bowl))),
      maxAch: Math.max(0, ...bowlQ.map(achBowlPoints)),
    };
    // Season pools: best figures within the ongoing season sheet.
    const sBatRows = seasonPlayers.filter(s => s.bat.inns > 0);
    const sBowlRows = seasonPlayers.filter(s => s.bowl.inns > 0);
    const seasonBatPool = {
      maxRuns: Math.max(0, ...sBatRows.map(s => s.bat.runs)),
      maxAvg: Math.max(0, ...sBatRows.map(s => batAvg(s.bat))),
      maxSR: Math.max(0, ...sBatRows.map(s => batSR(s.bat))),
    };
    const seasonBowlPool = {
      maxWkts: Math.max(0, ...sBowlRows.map(s => s.bowl.wkts)),
      minAvg: finiteMin(sBowlRows.map(s => bowlAvg(s.bowl))),
      minEco: finiteMin(sBowlRows.map(s => bowlEco(s.bowl))),
      maxDot: Math.max(0, ...sBowlRows.map(s => dotPct(s.bowl))),
    };

    // Form: season score when the player has played this season; career
    // score when no season data exists yet; a scaled-down career score
    // when the season is under way without them.
    const hasSeason = seasonPlayers.length > 0;
    const formBat = (c, career) => {
      if (!hasSeason) return career;
      const s = seasonMap.get(c.key);
      return (s && s.bat.inns > 0) ? seasonBatScore(s, seasonBatPool) : FORM_FALLBACK_ABSENT * career;
    };
    const formBowl = (c, career) => {
      if (!hasSeason) return career;
      const s = seasonMap.get(c.key);
      return (s && s.bowl.inns > 0) ? seasonBowlScore(s, seasonBowlPool) : FORM_FALLBACK_ABSENT * career;
    };

    const ratings = new Map(); // key → { bat, bowl }
    careers.forEach(c => {
      const batCareer = careerBatScore(c, batPool);
      const bowlCareer = careerBowlScore(c, bowlPool);
      const bat = finalRating(
        batCareer, formBat(c, batCareer),
        100 * ratioHi(achBatPoints(c), batPool.maxAch),
        interp(EXP_CURVE, c.bat.inns),
        c.bat.inns);
      const bowl = finalRating(
        bowlCareer, formBowl(c, bowlCareer),
        100 * ratioHi(achBowlPoints(c), bowlPool.maxAch),
        interp(EXP_CURVE, c.bowl.inns),
        c.bowl.inns);
      ratings.set(c.key, { bat, bowl });
    });

    const list = (pool, rating) => pool
      .map(c => ({ name: c.name, rating: rating(c) }))
      .sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name))
      .map((r, i) => ({ pos: i + 1, name: r.name, rating: r.rating }));

    return {
      date: dateStr,
      batting: list(batQ, c => ratings.get(c.key).bat),
      bowling: list(bowlQ, c => ratings.get(c.key).bowl),
      // All-rounder: balanced 50/50 combination via the geometric mean -
      // a player must contribute with BOTH bat and ball to rank highly.
      allrounder: list(careers.filter(c => batQualified(c) && bowlQualified(c)),
        c => Math.round(Math.sqrt(ratings.get(c.key).bat * ratings.get(c.key).bowl))),
    };
  }

  /* ----------------------- browser bootstrap ----------------------- */

  const state = { status: "loading", snapshot: null };
  const listeners = new Set();
  const emit = () => listeners.forEach(cb => { try { cb(); } catch (e) { console.error(e); } });
  const today = () => new Date().toISOString().slice(0, 10);

  function snapshotDate(data) {
    if (data.season && data.season.importedAt) return data.season.importedAt;
    if (data.baseline && data.baseline.importedAt) return data.baseline.importedAt;
    return today();
  }
  function recompute(data) {
    state.snapshot = computeAll(data, snapshotDate(data));
    saveSnapshot(state.snapshot);
    state.status = "ready";
    emit();
  }

  async function fetchText(file) {
    try {
      const res = await fetch(encodeURI(file), { cache: "no-store" });
      return res.ok ? await res.text() : null;
    } catch (e) { return null; } // offline / file:// - stored data covers us
  }

  async function importAndCompute() {
    if (hasStorage) OLD_KEYS.forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
    const data = loadData();
    let changed = false;

    if (typeof fetch === "function") {
      // 1. Baseline (all-time combined sheet).
      const baseText = await fetchText(BASELINE_FILE);
      if (baseText) {
        const players = parsePlayersCSV(baseText);
        if (players.length) {
          const fp = hash(baseText);
          if (!data.baseline || data.baseline.fingerprint !== fp) {
            // SEASON ROLLOVER: a replaced combined sheet already contains
            // the season we were tracking - drop the stored season data.
            if (data.baseline && data.season) data.season = null;
            data.baseline = { fingerprint: fp, importedAt: today(), players };
            changed = true;
          }
        }
      }
      // 2. Ongoing season sheet (optional; manual import wins on this device).
      if (!data.season || data.season.source !== "import") {
        const seasonText = await fetchText(SEASON_FILE);
        if (seasonText) {
          const players = parsePlayersCSV(seasonText);
          if (players.length) {
            const fp = hash(seasonText);
            if (!data.season || data.season.fingerprint !== fp) {
              data.season = { fingerprint: fp, importedAt: today(), source: "file", players };
              changed = true;
            }
          }
        }
      }
    }

    if (changed) saveData(data);
    if ((data.baseline && data.baseline.players.length) || (data.season && data.season.players.length)) {
      recompute(data);
    } else {
      state.snapshot = loadSnapshot(); // last resort: previous computed snapshot
      state.status = "ready";
      emit();
    }
  }

  const api = {
    onChange(cb) { listeners.add(cb); if (state.status === "ready") cb(); return () => listeners.delete(cb); },
    getRanking(cat) {
      const snap = state.snapshot;
      const rows = (snap && snap[cat]) || [];
      return { loading: state.status === "loading", available: rows.length > 0, updated: snap ? snap.date : null, rows };
    },
    getStatus() {
      const d = loadData();
      return {
        baselineDate: d.baseline ? d.baseline.importedAt : null,
        seasonDate: d.season ? d.season.importedAt : null,
        seasonSource: d.season ? d.season.source : null,
      };
    },
    refresh() { state.status = "loading"; emit(); return importAndCompute(); },

    // Admin/moderator weekly import: the ongoing season's cumulative CSV.
    // Replaces the previous season data, recalculates, notifies the UI.
    importSeasonCSV(csvText) {
      const text = String(csvText || "");
      const players = parsePlayersCSV(text);
      if (!players.length) return { ok: false, error: "No player rows found in that CSV" };
      const data = loadData();
      data.season = { fingerprint: hash(text), importedAt: today(), source: "import", players };
      saveData(data);
      recompute(data);
      return { ok: true, count: players.length };
    },
  };

  if (typeof window !== "undefined") {
    window.HCCLRanking = api;
    importAndCompute();
  }

  // Node test hook (inert in the browser).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      parseCSV, parsePlayersCSV, computeAll,
      makeData(baselineText, seasonText) {
        return {
          baseline: baselineText ? { fingerprint: hash(baselineText), importedAt: "test", players: parsePlayersCSV(baselineText) } : null,
          season: seasonText ? { fingerprint: hash(seasonText), importedAt: "test", source: "import", players: parsePlayersCSV(seasonText) } : null,
        };
      },
    };
  }
})();
