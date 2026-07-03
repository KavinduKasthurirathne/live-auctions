/* ============================================================
   HCCL Player Ranking ENGINE  (data + math only — no UI)

   Consumed by ranking.js (the UI). Exposes window.HCCLRanking:
     onChange(cb)      — subscribe; called (immediately if ready) when
                         rankings are (re)computed
     getRanking(cat)   — "batting" | "bowling" | "allrounder" →
                         { available, updated, rows:[{pos,name,rating}] }
     refresh()         — re-fetch the CSVs and recompute

   DATA FLOW
   1. On load, fetch every season CSV listed in SEASONS (the folder is
      served as a static asset). Each file is one season's cumulative
      player stats — a weekly export mid-season simply REPLACES that
      season's snapshot; older seasons are never touched.
   2. Parsed snapshots are merged into a history store in localStorage
      (keyed by season id → append/update, never overwrite the rest),
      so the last good data still ranks if a fetch fails offline.
   3. Rankings are recalculated from the FULL history every load and
      the latest result is saved as a dated snapshot.

   WEEKLY UPDATES: overwrite the current season's CSV (e.g. S6.csv)
   with the new export — or add S7.csv plus one line in SEASONS —
   commit, deploy. Next page load re-imports and re-ranks.

   RATING MODEL — based on the "HCCL Batting Rankings Explanation" PDF:
     Rating = 100 + 5×Career + 3×RecentForm + 1×Achievements + 1×Experience
     (each component 0–100, rating clamped to the 0–1000 scale)
   Career/achievements are normalized against the best QUALIFIED player
   (score = player ÷ best × 100). The PDF's "last 5 matches" form is
   season-based here (the CSVs are per-season), using recency weights:
   latest 1.00, then 0.80, 0.60, 0.40, 0.20 for older seasons — plus an
   inactivity decay so players who stopped playing fade over time.
   A confidence factor shrinks ratings toward the 100 base when a
   player has too few innings to judge reliably.
   ============================================================ */
(function () {
  "use strict";

  /* ------------------------- configuration ------------------------- */

  // Season manifest, oldest → newest. Weekly update = replace the newest
  // file; new season = add a row here.
  const SEASONS = [
    { id: "S1", order: 1, file: "HCCL Player Stats/S1.csv" },
    { id: "S2", order: 2, file: "HCCL Player Stats/S2.csv" },
    { id: "S3", order: 3, file: "HCCL Player Stats/S3.csv" },
    { id: "S4", order: 4, file: "HCCL Player Stats/S4.csv" },
    { id: "S5", order: 5, file: "HCCL Player Stats/S5.csv" },
    { id: "S6", order: 6, file: "HCCL Player Stats/S6.csv" },
  ];

  // Recency weights by "seasons ago" from the league's latest season
  // (index 0 = latest). Anything older uses the last entry.
  const RECENCY = [1.0, 0.8, 0.6, 0.4, 0.2];

  // Qualification for the official lists (per the PDF for batting;
  // bowling mirrors it). Unqualified players still accumulate ratings
  // internally but are not shown.
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

  const KEY_HISTORY = "hccl_ranking_history_v1";
  const KEY_SNAPSHOT = "hccl_ranking_latest_v1";

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

  // One CSV row → a normalized per-season player snapshot. Missing
  // columns/values just become 0 — a thinner weekly export still works.
  function normalizeRow(r) {
    return {
      name: displayName(r["Player Name"]),
      key: nameKey(r["Player Name"]),
      team: displayName(r["Team Name"]),
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

  function parseSeasonCSV(text) {
    const byKey = new Map();
    parseCSV(text).forEach(raw => {
      const s = normalizeRow(raw);
      if (!s.key) return;
      const prev = byKey.get(s.key);
      if (!prev) { byKey.set(s.key, s); return; }
      // Duplicate row for the same player (e.g. mid-season team move):
      // merge by summing counting stats, keep maxima where relevant.
      ["matches", "pom"].forEach(k => prev[k] += s[k]);
      Object.keys(prev.bat).forEach(k => { k === "high" ? prev.bat.high = Math.max(prev.bat.high, s.bat.high) : prev.bat[k] += s.bat[k]; });
      Object.keys(prev.bowl).forEach(k => prev.bowl[k] += s.bowl[k]);
      prev.team = s.team || prev.team;
    });
    return [...byKey.values()];
  }

  /* ----------------- history store (localStorage) ------------------ */

  const hasStorage = typeof localStorage !== "undefined";
  function loadHistory() {
    if (!hasStorage) return { seasons: {} };
    try { return JSON.parse(localStorage.getItem(KEY_HISTORY)) || { seasons: {} }; }
    catch (e) { return { seasons: {} }; }
  }
  function saveHistory(h) {
    if (!hasStorage) return;
    try { localStorage.setItem(KEY_HISTORY, JSON.stringify(h)); } catch (e) { /* full — history is rebuilt from CSVs anyway */ }
  }
  // Append/update one season snapshot; the rest of history is untouched.
  function mergeSeason(history, id, order, players, importedAt) {
    history.seasons[id] = { id, order, importedAt, players };
    return history;
  }

  /* ------------------------- rating engine ------------------------- */

  // Collapse history into one career record per player.
  function buildCareers(history) {
    const careers = new Map();
    const seasons = Object.values(history.seasons || {}).sort((a, b) => a.order - b.order);
    seasons.forEach(se => {
      se.players.forEach(p => {
        let c = careers.get(p.key);
        if (!c) {
          c = { key: p.key, name: p.name, seasons: [],
            bat: { inns: 0, runs: 0, notOuts: 0, balls: 0, t30: 0, t50: 0, t100: 0, high: 0 },
            bowl: { inns: 0, wkts: 0, conceded: 0, balls: 0, maidens: 0, dots: 0, w3: 0, w5: 0 },
            pom: 0, matches: 0 };
          careers.set(p.key, c);
        }
        c.name = p.name; // latest spelling wins
        c.matches += p.matches; c.pom += p.pom;
        Object.keys(c.bat).forEach(k => { k === "high" ? c.bat.high = Math.max(c.bat.high, p.bat.high) : c.bat[k] += p.bat[k]; });
        Object.keys(c.bowl).forEach(k => c.bowl[k] += p.bowl[k]);
        c.seasons.push({ order: se.order, snap: p });
      });
    });
    return { careers: [...careers.values()], latestOrder: seasons.length ? seasons[seasons.length - 1].order : 0 };
  }

  // Derived career figures (computed from raw totals, not averaged averages).
  const batAvg = b => b.runs / Math.max(1, b.inns - b.notOuts);
  const batSR = b => (b.balls > 0 ? (b.runs / b.balls) * 100 : 0);
  const bowlAvg = b => (b.wkts > 0 ? b.conceded / b.wkts : Infinity);
  const bowlEco = b => (b.balls > 0 ? b.conceded / (b.balls / 6) : Infinity);
  const dotPct = b => (b.balls > 0 ? b.dots / b.balls : 0);

  const batQualified = c => c.bat.inns >= QUAL.batting.innings && c.bat.runs >= QUAL.batting.runs;
  const bowlQualified = c => c.bowl.inns >= QUAL.bowling.innings && c.bowl.wkts >= QUAL.bowling.wickets;

  // Career score (PDF): 50% volume + 30% average + 20% strike-rate/economy
  // shape, each normalized against the best qualified career.
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

  // Same shapes applied to a single season row (vs per-season pools) —
  // these feed the recency-weighted form component.
  const seasonBatScore = (s, P) => 100 * (0.5 * ratioHi(s.bat.runs, P.maxRuns)
    + 0.3 * ratioHi(batAvg(s.bat), P.maxAvg) + 0.2 * ratioHi(batSR(s.bat), P.maxSR));
  const seasonBowlScore = (s, P) => 100 * (0.5 * ratioHi(s.bowl.wkts, P.maxWkts)
    + 0.25 * ratioLo(P.minAvg, bowlAvg(s.bowl)) + 0.15 * ratioLo(P.minEco, bowlEco(s.bowl))
    + 0.10 * ratioHi(dotPct(s.bowl), P.maxDot));

  const recencyWeight = seasonsAgo => RECENCY[Math.min(Math.max(seasonsAgo, 0), RECENCY.length - 1)];

  // Recency-weighted form: weighted mean of season scores (weights by how
  // long ago the season was), then decayed by the weight of the player's
  // most recent season — so inactive players fade instead of freezing.
  function formScore(c, latestOrder, played, score) {
    const rows = c.seasons.filter(x => played(x.snap));
    if (!rows.length) return 0;
    let sum = 0, wsum = 0, lastOrder = 0;
    rows.forEach(x => {
      const w = recencyWeight(latestOrder - x.order);
      sum += w * score(x.snap); wsum += w;
      lastOrder = Math.max(lastOrder, x.order);
    });
    return (sum / wsum) * recencyWeight(latestOrder - lastOrder);
  }

  const achBatPoints = c => ACH_BAT.t30 * c.bat.t30 + ACH_BAT.t50 * c.bat.t50 + ACH_BAT.t100 * c.bat.t100 + ACH_BAT.pom * c.pom;
  const achBowlPoints = c => ACH_BOWL.w3 * c.bowl.w3 + ACH_BOWL.w5 * c.bowl.w5 + ACH_BOWL.maiden * c.bowl.maidens + ACH_BOWL.pom * c.pom;

  // PDF final formula, shrunk toward the 100 base by the confidence
  // factor and clamped to the 0–1000 scale.
  function finalRating(career, form, ach, exp, inns) {
    const raw = 100 + 5 * career + 3 * form + 1 * ach + 1 * exp;
    const conf = clamp(inns / CONF_FULL_INNINGS, 0, 1);
    return clamp(Math.round(100 + conf * (raw - 100)), 0, 1000);
  }

  // Full recalculation from history → dated ranking snapshot.
  function computeAll(history, dateStr) {
    const { careers, latestOrder } = buildCareers(history);
    if (!careers.length) return { date: dateStr, batting: [], bowling: [], allrounder: [] };

    const batQ = careers.filter(batQualified);
    const bowlQ = careers.filter(bowlQualified);

    // Normalization pools — "best qualified player" per the PDF.
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
    // Season pools: best single-season figures across all played rows.
    const allSeasonRows = careers.flatMap(c => c.seasons.map(x => x.snap));
    const batRows = allSeasonRows.filter(s => s.bat.inns > 0);
    const bowlRows = allSeasonRows.filter(s => s.bowl.inns > 0);
    const seasonBatPool = {
      maxRuns: Math.max(0, ...batRows.map(s => s.bat.runs)),
      maxAvg: Math.max(0, ...batRows.map(s => batAvg(s.bat))),
      maxSR: Math.max(0, ...batRows.map(s => batSR(s.bat))),
    };
    const seasonBowlPool = {
      maxWkts: Math.max(0, ...bowlRows.map(s => s.bowl.wkts)),
      minAvg: finiteMin(bowlRows.map(s => bowlAvg(s.bowl))),
      minEco: finiteMin(bowlRows.map(s => bowlEco(s.bowl))),
      maxDot: Math.max(0, ...bowlRows.map(s => dotPct(s.bowl))),
    };

    const ratings = new Map(); // key → { bat, bowl }
    careers.forEach(c => {
      const bat = finalRating(
        careerBatScore(c, batPool),
        formScore(c, latestOrder, s => s.bat.inns > 0, s => seasonBatScore(s, seasonBatPool)),
        100 * ratioHi(achBatPoints(c), batPool.maxAch),
        interp(EXP_CURVE, c.bat.inns),
        c.bat.inns);
      const bowl = finalRating(
        careerBowlScore(c, bowlPool),
        formScore(c, latestOrder, s => s.bowl.inns > 0, s => seasonBowlScore(s, seasonBowlPool)),
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
      // All-rounder: balanced 50/50 combination via the geometric mean —
      // a player must contribute with BOTH bat and ball to rank highly
      // (one-dimensional stars can't ride a single skill to the top).
      allrounder: list(careers.filter(c => batQualified(c) && bowlQualified(c)),
        c => Math.round(Math.sqrt(ratings.get(c.key).bat * ratings.get(c.key).bowl))),
    };
  }

  /* ----------------------- browser bootstrap ----------------------- */

  const state = { status: "loading", snapshot: null };
  const listeners = new Set();
  const emit = () => listeners.forEach(cb => { try { cb(); } catch (e) { console.error(e); } });
  const today = () => new Date().toISOString().slice(0, 10);

  function loadSnapshot() {
    if (!hasStorage) return null;
    try { return JSON.parse(localStorage.getItem(KEY_SNAPSHOT)); } catch (e) { return null; }
  }
  function saveSnapshot(snap) {
    if (!hasStorage) return;
    try { localStorage.setItem(KEY_SNAPSHOT, JSON.stringify(snap)); } catch (e) {}
  }

  async function importAndCompute() {
    const history = loadHistory();
    let fetched = 0;
    if (typeof fetch === "function") {
      await Promise.all(SEASONS.map(async se => {
        try {
          const res = await fetch(encodeURI(se.file), { cache: "no-store" });
          if (!res.ok) return;
          const players = parseSeasonCSV(await res.text());
          if (players.length) { mergeSeason(history, se.id, se.order, players, today()); fetched++; }
        } catch (e) { /* offline / file:// — stored history covers us */ }
      }));
    }
    if (fetched) saveHistory(history);

    if (Object.keys(history.seasons || {}).length) {
      state.snapshot = computeAll(history, today());
      saveSnapshot(state.snapshot);
    } else {
      state.snapshot = loadSnapshot(); // last resort: previous computed snapshot
    }
    state.status = "ready";
    emit();
  }

  const api = {
    onChange(cb) { listeners.add(cb); if (state.status === "ready") cb(); return () => listeners.delete(cb); },
    getRanking(cat) {
      const snap = state.snapshot;
      const rows = (snap && snap[cat]) || [];
      return { loading: state.status === "loading", available: rows.length > 0, updated: snap ? snap.date : null, rows };
    },
    refresh() { state.status = "loading"; emit(); return importAndCompute(); },
  };

  if (typeof window !== "undefined") {
    window.HCCLRanking = api;
    importAndCompute();
  }

  // Node test hook (inert in the browser).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      parseCSV, parseSeasonCSV, mergeSeason, computeAll,
      buildHistoryFromTexts(texts) {
        const h = { seasons: {} };
        SEASONS.forEach(se => { if (texts[se.id]) mergeSeason(h, se.id, se.order, parseSeasonCSV(texts[se.id]), "test"); });
        return h;
      },
    };
  }
})();
