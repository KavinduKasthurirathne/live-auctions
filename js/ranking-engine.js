/* ============================================================
   HCCL Ranking Engine  (window.HCCLRanking)

   Pure, DOM-free logic that turns a raw HCCL stats CSV into
   rating rows. Kept separate from ranking.js (rendering) and
   ranking-data.js (the bundled CSV) so the SAME code path serves
   both the current bundled sheet and the future moderator
   "Import stats CSV" upload.

   Implements the official "HCCL Rating System v1.0" EXACTLY - no
   rounding of sub-scores and no clamping anywhere.

     Final rating = 100 + 5*Career + 3*RecentForm + Achievement + Experience
       (base 100 is the floor; the scale is ~100-1000, not hard-capped)

     Career Score = 0.5*RunsScore + 0.3*AvgScore + 0.2*SrScore
       each XScore = player.X / (highest X among ELIGIBLE batters) * 100

     Recent Form Score = sum(last 5 match points) / 5   (no clamping)
       Per-match points:
         Runs:  0 -> -10 | 1-5 -> 0 | 6-9 -> +5 | 10-19 -> +10
                20-29 -> +25 | 30-49 -> +35 | 50+ -> +50
         SR bonus:  <100 -> -10 | >200 -> +5 | >300 -> +10 (else 0)
         + Highest scorer +20 | Not out +5 | POTM +20
         DNB (did not bat) -> 0

     Achievement Score = player.RAP / (highest RAP among eligible) * 100
     Experience Score  = fixed tier by career innings (NOT a benchmark):
       50+ -> 100 | 40-49 -> 70 | 30-39 -> 50 | 20-29 -> 30 | 10-19 -> 10

   Eligibility: >= 10 innings AND >= 100 career runs.
   ============================================================ */
(function () {
  "use strict";

  function clamp(n, lo, hi) { return n < lo ? lo : n > hi ? hi : n; }
  function num(v) { const n = parseFloat(String(v).replace(/[^0-9.\-]/g, "")); return isFinite(n) ? n : 0; }
  function titleCase(s) {
    return String(s || "").toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  }

  /* -------------------------- CSV parsing -------------------------- */
  // RFC-4180-ish: handles quoted fields, escaped "" quotes, and the
  // multi-line "Recent 5 Matches" cells (newlines inside quotes).
  function parseCsv(text) {
    const rows = [];
    let field = "", row = [], inQ = false;
    text = String(text).replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQ = false;
        } else field += c;
      } else if (c === '"') {
        inQ = true;
      } else if (c === ",") {
        row.push(field); field = "";
      } else if (c === "\n") {
        row.push(field); rows.push(row); row = []; field = "";
      } else field += c;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  // Fallback positional layout (the original sheet), used only if a sheet's
  // header can't be recognised.
  const COL = {
    id: 0, name: 1, team: 2,
    innings: 3, runs: 4, avg: 5, sr: 6, thirties: 7, fifties: 8, ducks: 9,
    potms: 10, rap: 11, recentBat: 12,
    wickets: 13, bowlAvg: 14, eco: 15, threeFers: 16, fourFers: 17,
    bsr: 18, bap: 19, recentBowl: 20,
  };

  // Resolve column indices from the HEADER ROW by name, so the engine is
  // robust to added/reordered columns (e.g. a new sheet inserting "Balls
  // Faced" / "Balls Bowled" or trailing extras). The header repeats "AVG"
  // and "Recent 5 Matches" for the batting vs bowling halves, so those are
  // split around the WICKETS column. Falls back to COL for unknown headers.
  function resolveCols(header) {
    const norm = s => String(s == null ? "" : s).replace(/﻿/g, "").trim().toLowerCase();
    const H = (header || []).map(norm);
    const first = name => H.indexOf(norm(name));
    const allOf = name => H.reduce((a, h, i) => (h === norm(name) ? a.concat(i) : a), []);
    if (first("ID") < 0 || first("NAME") < 0) return COL; // not a recognisable HCCL header
    const wickets = first("WICKETS");
    const avgs = allOf("AVG");
    const recents = allOf("Recent 5 Matches");
    const beforeW = i => wickets < 0 || i < wickets;
    const afterW = i => wickets >= 0 && i > wickets;
    const pick = (list, pred) => { const v = list.find(pred); return v == null ? -1 : v; };
    return {
      id: first("ID"), name: first("NAME"), team: first("TEAM"),
      innings: first("Innings"), runs: first("RUNS"),
      avg: pick(avgs, beforeW), sr: first("SR"),
      potms: first("POTMs"), rap: first("RAP"), recentBat: pick(recents, beforeW),
      wickets, bowlAvg: pick(avgs, afterW), eco: first("ECO"),
      threeFers: first("3Fers"), fourFers: first("4Fers"), bsr: first("BSR"),
      recentBowl: pick(recents, afterW),
    };
  }

  // Parse one "Recent 5 Matches" batting cell into up to 5 match objects.
  // Lines look like: "1. 81 runs, 300 SR, Highest scorer Yes, Not out No, POTM Yes"
  // or "1. DNB, POTM No" (did not bat).
  function parseRecentBatting(cell) {
    return String(cell || "")
      .split("\n")
      .map(l => l.trim())
      .filter(Boolean)
      .map(line => {
        if (/\bDNB\b/i.test(line)) return { dnb: true };
        const runsM = line.match(/(-?\d+(?:\.\d+)?)\s*runs/i);
        const srM = line.match(/([\d.]+)\s*SR/i);
        return {
          dnb: false,
          runs: runsM ? Math.round(parseFloat(runsM[1])) : 0,
          sr: srM ? parseFloat(srM[1]) : 0,
          highest: /Highest scorer\s+Yes/i.test(line),
          notout: /Not out\s+Yes/i.test(line),
          potm: /POTM\s+Yes/i.test(line),
        };
      });
  }

  // Parse one "Recent 5 Matches" bowling cell into up to 5 match objects.
  // Lines look like: "3 Wickets, 8 Eco, POTM YES" or "DNB, POTM NO".
  function parseRecentBowling(cell) {
    return String(cell || "")
      .split("\n")
      .map(l => l.trim())
      .filter(Boolean)
      .map(line => {
        if (/\bDNB\b/i.test(line)) return { dnb: true };
        const wM = line.match(/(-?\d+)\s*Wickets?/i);
        const eM = line.match(/([\d.]+)\s*Eco/i);
        return {
          dnb: false,
          wickets: wM ? parseInt(wM[1], 10) : 0,
          eco: eM ? parseFloat(eM[1]) : 0,
          potm: /POTM\s+Yes/i.test(line),
        };
      });
  }

  // Raw CSV text -> array of player stat objects.
  function parsePlayers(csvText) {
    const rows = parseCsv(csvText);
    const cols = resolveCols(rows[0] || []); // map columns by header name
    const players = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || !/^P\d+/i.test((r[cols.id] || "").trim())) continue; // skip header/blank rows
      players.push({
        id: (r[cols.id] || "").trim(),
        name: (r[cols.name] || "").trim(),
        team: titleCase((r[cols.team] || "").trim()),
        potms: Math.round(num(r[cols.potms])), // career Player-of-the-Match count (used by bowling achievements)
        // batting
        innings: Math.round(num(r[cols.innings])),
        runs: Math.round(num(r[cols.runs])),
        avg: num(r[cols.avg]),
        sr: num(r[cols.sr]),
        rap: Math.round(num(r[cols.rap])),
        recentBat: parseRecentBatting(r[cols.recentBat]),
        // bowling
        wickets: Math.round(num(r[cols.wickets])),
        bowlAvg: num(r[cols.bowlAvg]),
        eco: num(r[cols.eco]),
        threeFers: Math.round(num(r[cols.threeFers])),
        fourFers: Math.round(num(r[cols.fourFers])),
        bsr: num(r[cols.bsr]), // bowling strike rate (balls per wicket, lower better)
        recentBowl: parseRecentBowling(r[cols.recentBowl]),
      });
    }
    return players;
  }

  /* ---------------------- batting rating math ---------------------- */
  const BAT_ELIGIBLE = { innings: 10, runs: 100 };
  const BAT_BASE = 100; // base points; performance fills BASE..1000

  // Points for a single recent batting innings (see header for the table).
  function battingMatchPoints(m) {
    if (!m || m.dnb) return 0;
    const r = m.runs;
    let rp;
    if (r <= 0) rp = -10;
    else if (r <= 5) rp = 0;
    else if (r <= 9) rp = 5;
    else if (r <= 19) rp = 10;
    else if (r <= 29) rp = 25;
    else if (r <= 49) rp = 35;
    else rp = 50;

    const s = m.sr;
    let sb;
    if (s < 100) sb = -10;
    else if (s < 200) sb = 0;
    else if (s < 300) sb = 5;
    else sb = 10;

    let extra = 0;
    if (m.highest) extra += 20;
    if (m.notout) extra += 5;
    if (m.potm) extra += 20;
    return rp + sb + extra;
  }

  function recentFormScore(recentBat) {
    const sum = (recentBat || []).reduce((a, m) => a + battingMatchPoints(m), 0);
    return sum / 5; // HCCL v1.0: average of the last 5 matches, no clamping
  }

  // Experience score is a fixed tier by career innings (HCCL v1.0), NOT a
  // benchmark - so there is no "Highest Innings" benchmark.
  function battingExperience(innings) {
    if (innings >= 50) return 100;
    if (innings >= 40) return 70;
    if (innings >= 30) return 50;
    if (innings >= 20) return 30;
    if (innings >= 10) return 10;
    return 0;
  }

  function isBattingEligible(p) {
    return p.innings >= BAT_ELIGIBLE.innings && p.runs >= BAT_ELIGIBLE.runs;
  }

  // players (from parsePlayers) -> { rows, meta }.
  // rows are the ELIGIBLE batters, sorted best-first, with positions
  // (ties share a position, then the numbering skips). Each row keeps
  // its component breakdown for tooltips / debugging later.
  function computeBatting(players) {
    const eligible = (players || []).filter(isBattingEligible);
    // Benchmarks = highest value among eligible batters (HCCL v1.0).
    const maxOf = key => eligible.reduce((m, p) => Math.max(m, p[key] || 0), 0);
    const max = { runs: maxOf("runs"), avg: maxOf("avg"), sr: maxOf("sr"), rap: maxOf("rap") };

    const rows = eligible.map(p => {
      // Career sub-scores = player value / highest eligible value * 100
      // (HCCL v1.0 - no rounding, no clamping).
      const runsScore = max.runs ? (p.runs / max.runs) * 100 : 0;
      const avgScore = max.avg ? (p.avg / max.avg) * 100 : 0;
      const srScore = max.sr ? (p.sr / max.sr) * 100 : 0;
      const career = 0.5 * runsScore + 0.3 * avgScore + 0.2 * srScore;
      const recent = recentFormScore(p.recentBat);
      const achievement = max.rap ? (p.rap / max.rap) * 100 : 0;
      const experience = battingExperience(p.innings); // fixed tier, not a benchmark

      // HCCL v1.0 final: 100 + 5*Career + 3*Recent + Achievement + Experience.
      // No clamping (base 100 is the floor; max is ~1000).
      const rating = BAT_BASE + 5 * career + 3 * recent + achievement + experience;
      return {
        id: p.id, name: p.name, team: p.team,
        rating: Math.round(rating), ratingRaw: rating,
        breakdown: {
          career: +career.toFixed(1), recent: +recent.toFixed(1),
          achievement: +achievement.toFixed(1), experience: +experience.toFixed(1),
        },
        stats: { innings: p.innings, runs: p.runs, avg: p.avg, sr: p.sr, rap: p.rap },
      };
    });

    // Best first; tie-break by raw rating then career runs then name.
    rows.sort((a, b) =>
      b.rating - a.rating ||
      b.ratingRaw - a.ratingRaw ||
      b.stats.runs - a.stats.runs ||
      a.name.localeCompare(b.name));

    // Standard competition ranking on the DISPLAYED (rounded) rating.
    let prev = null, prevPos = 0;
    rows.forEach((row, idx) => {
      if (prev !== null && row.rating === prev) row.pos = prevPos;
      else { row.pos = idx + 1; prevPos = row.pos; prev = row.rating; }
    });

    return {
      rows,
      meta: { max, eligibleCount: eligible.length, totalPlayers: (players || []).length },
    };
  }

  // Convenience: raw CSV -> computed batting result.
  function battingFromCsv(csvText) {
    return computeBatting(parsePlayers(csvText));
  }

  /* ---------------------- bowling rating math ---------------------- */
  // Official "HCCL Bowling Rating System v1.0" - no rounding, no clamping.
  //
  //   Rating = 100 + 5*Career + 3*RecentForm + 2*Achievement
  //   Career = 0.6*WicketsScore + 0.2*AvgScore + 0.1*EcoScore + 0.1*SrScore
  //     WicketsScore = wickets / (most wickets among eligible) * 100
  //     AvgScore/EcoScore/SrScore = (best among eligible) / player * 100  (lower is better)
  //   RecentForm = avg of last-5 match scores / 5   (no clamping)
  //     match = WicketPts(0/25/50/75/100 for 0/1/2/3/4+ wkts)
  //           + EcoBonus(<6:+20 | <9:+10 | <12:+5 | >15:-10 | else 0)
  //           + POTM(+20); DNB -> 0
  //   Achievement = AchPoints / (highest among eligible) * 100
  //     AchPoints = 3Fers*15 + 4Fers*35 + POTMs*50   (== the sheet's BAP column)
  //
  // Qualification (HCCL v1.0): minimum 10 career wickets.
  const BOWL_ELIGIBLE = { wickets: 10 };
  const BOWL_BASE = 100;

  function bowlingMatchPoints(m) {
    if (!m || m.dnb) return 0;
    const w = m.wickets;
    const wp = w <= 0 ? 0 : w === 1 ? 25 : w === 2 ? 50 : w === 3 ? 75 : 100;
    const e = m.eco;
    let eb;
    if (e < 6) eb = 20;
    else if (e < 9) eb = 10;
    else if (e < 12) eb = 5;
    else if (e > 15) eb = -10;
    else eb = 0;
    return wp + eb + (m.potm ? 20 : 0);
  }

  function bowlingRecentFormScore(recentBowl) {
    const sum = (recentBowl || []).reduce((a, m) => a + bowlingMatchPoints(m), 0);
    return sum / 5; // HCCL v1.0: average of the last 5 matches, no clamping
  }

  function bowlingAchievementPoints(p) {
    return (p.threeFers || 0) * 15 + (p.fourFers || 0) * 35 + (p.potms || 0) * 50;
  }

  function isBowlingEligible(p) {
    return p.wickets >= BOWL_ELIGIBLE.wickets;
  }

  // players -> { rows, meta }. rows are eligible bowlers, best-first, with
  // positions (ties share a position). Each row keeps its breakdown.
  function computeBowling(players) {
    const eligible = (players || []).filter(isBowlingEligible);
    const maxOf = key => eligible.reduce((m, p) => Math.max(m, p[key] || 0), 0);
    // "best" for the lower-is-better metrics = minimum positive value.
    const minPos = key => eligible.reduce((m, p) => (p[key] > 0 && p[key] < m ? p[key] : m), Infinity);
    const bench = {
      wickets: maxOf("wickets"),
      avg: minPos("bowlAvg"),
      eco: minPos("eco"),
      bsr: minPos("bsr"),
      ap: eligible.reduce((m, p) => Math.max(m, bowlingAchievementPoints(p)), 0),
    };

    const rows = eligible.map(p => {
      // Career sub-scores (HCCL v1.0 - no rounding, no clamping). Wickets:
      // higher is better; avg/eco/SR: lower is better, so benchmark / player.
      const wicketsScore = bench.wickets ? (p.wickets / bench.wickets) * 100 : 0;
      const avgScore = p.bowlAvg > 0 && isFinite(bench.avg) ? (bench.avg / p.bowlAvg) * 100 : 0;
      const ecoScore = p.eco > 0 && isFinite(bench.eco) ? (bench.eco / p.eco) * 100 : 0;
      const srScore = p.bsr > 0 && isFinite(bench.bsr) ? (bench.bsr / p.bsr) * 100 : 0;
      const career = 0.6 * wicketsScore + 0.2 * avgScore + 0.1 * ecoScore + 0.1 * srScore;
      const recent = bowlingRecentFormScore(p.recentBowl);
      const ap = bowlingAchievementPoints(p);
      const achievement = bench.ap ? (ap / bench.ap) * 100 : 0;

      // HCCL v1.0 final: 100 + 5*Career + 3*Recent + 2*Achievement (no clamping).
      const rating = BOWL_BASE + 5 * career + 3 * recent + 2 * achievement;
      return {
        id: p.id, name: p.name, team: p.team,
        rating: Math.round(rating), ratingRaw: rating,
        breakdown: {
          career: +career.toFixed(1), recent: +recent.toFixed(1), achievement: +achievement.toFixed(1),
        },
        stats: { wickets: p.wickets, bowlAvg: p.bowlAvg, eco: p.eco, bsr: p.bsr, ap },
      };
    });

    rows.sort((a, b) =>
      b.rating - a.rating ||
      b.ratingRaw - a.ratingRaw ||
      b.stats.wickets - a.stats.wickets ||
      a.name.localeCompare(b.name));

    let prev = null, prevPos = 0;
    rows.forEach((row, idx) => {
      if (prev !== null && row.rating === prev) row.pos = prevPos;
      else { row.pos = idx + 1; prevPos = row.pos; prev = row.rating; }
    });

    return { rows, meta: { bench, eligibleCount: eligible.length, totalPlayers: (players || []).length } };
  }

  function bowlingFromCsv(csvText) {
    return computeBowling(parsePlayers(csvText));
  }

  /* --------------------- all-rounder rating math ------------------- */
  // AR Rating = sqrt(Batting Rating * Bowling Rating) - the geometric
  // mean of a player's two published ratings. A player must therefore be
  // ranked in BOTH boards (i.e. qualified as batter AND bowler); anyone
  // ranked in only one has no all-rounder rating.
  function computeAllRounder(players) {
    const bat = computeBatting(players);
    const bowl = computeBowling(players);
    const bowlById = {};
    bowl.rows.forEach(r => { bowlById[r.id] = r; });

    const rows = [];
    bat.rows.forEach(b => {
      const w = bowlById[b.id];
      if (!w) return; // needs a rating in both boards
      const ratingRaw = Math.sqrt(b.rating * w.rating);
      rows.push({
        id: b.id, name: b.name, team: b.team,
        rating: Math.round(ratingRaw), ratingRaw,
        breakdown: { batting: b.rating, bowling: w.rating },
      });
    });

    rows.sort((a, b) =>
      b.rating - a.rating ||
      b.ratingRaw - a.ratingRaw ||
      a.name.localeCompare(b.name));

    let prev = null, prevPos = 0;
    rows.forEach((row, idx) => {
      if (prev !== null && row.rating === prev) row.pos = prevPos;
      else { row.pos = idx + 1; prevPos = row.pos; prev = row.rating; }
    });

    return { rows, meta: { eligibleCount: rows.length, totalPlayers: (players || []).length } };
  }

  function allRounderFromCsv(csvText) {
    return computeAllRounder(parsePlayers(csvText));
  }

  window.HCCLRanking = {
    parseCsv, parsePlayers,
    battingMatchPoints, recentFormScore, isBattingEligible,
    computeBatting, battingFromCsv,
    bowlingMatchPoints, bowlingRecentFormScore, bowlingAchievementPoints, isBowlingEligible,
    computeBowling, bowlingFromCsv,
    computeAllRounder, allRounderFromCsv,
    BAT_ELIGIBLE, BAT_BASE, BOWL_ELIGIBLE, BOWL_BASE,
  };
})();
