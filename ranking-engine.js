/* ============================================================
   HCCL Player Ranking ENGINE  (data + math only - no UI)

   Consumed by ranking.js (the UI). Exposes window.HCCLRanking:
     onChange(cb)      - subscribe; called (immediately if ready) when
                         rankings are (re)computed
     getRanking(cat)   - "batting" | "bowling" | "allrounder" →
                         { available, updated, rows:[{pos,name,rating}] }
     refresh()         - re-fetch the CSVs and recompute

   DATA FLOW
   1. On load, fetch every season CSV listed in SEASONS (the folder is
      served as a static asset). Each file is one season's cumulative
      player stats - a weekly export mid-season simply REPLACES that
      season's snapshot; older seasons are never touched.
   2. Parsed snapshots are merged into a history store in localStorage
      (keyed by season id → append/update, never overwrite the rest),
      so the last good data still ranks if a fetch fails offline.
   3. Rankings are recalculated from the FULL history every load and
      the latest result is saved as a dated snapshot.

   WEEKLY UPDATES - two ways:
   a) In-app: an admin/moderator uses the "Weekly Stats Import" card on
      the Player Ranking page (importSeasonCSV). Instant, but local to
      that device until the CSV is also committed.
   b) Repo: overwrite the current season's CSV (e.g. S6.csv) - or add
      S7.csv plus one line in SEASONS - commit, deploy. Every device
      re-imports and re-ranks on next load. A manual in-app import for
      a season takes precedence over the fetched baseline on that device.

   RATING MODEL - structure from the "HCCL Batting Rankings Explanation"
   PDF (career + form + achievements + experience, 0-1000 scale), made
   recency-first:
     Rating = 100 + 4.5×Career + 3.5×Form + 1×Achievements + 1×Experience
     (each component 0-100, rating clamped to 0-1000)
   - EVERYTHING decays. Career totals, rates and achievement points are
     recency-weighted sums with an exponential half-life (a season played
     H seasons ago counts 50%, 2H ago 25%, ...) - history still counts,
     but an old great can't sit on a rating forever.
   - Form uses a much shorter half-life, so the latest season carries
     about as much weight as all older ones combined, and it decays
     further with how long ago the player last appeared - a player in
     hot current form rises fast; an absent one slides.
   - Components are normalized against an ADAPTIVE benchmark - the mean
     of the top-k qualified values - not the single all-time best, so one
     historical outlier can't permanently deflate everyone else.
   - Experience and confidence use smooth continuous curves (no step
     tiers); confidence shrinks ratings toward the 100 base when a
     player has too few innings to judge reliably.
   Qualification still uses RAW career totals (history is never erased,
   it just stops dominating). All tuning lives in the MODEL block below.
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

  // ---- rating model tuning (every dial in one place) ----
  const MODEL = {
    // Exponential decay half-lives, in seasons: weight = 0.5^(ago/H).
    // A season H seasons ago counts 50% of the current one, 2H ago 25%...
    HALF_LIFE_FORM: 1.0,    // form reacts fast - latest season dominates
    HALF_LIFE_CAREER: 2.5,  // career + achievements fade slower, but DO fade
    // Adaptive normalization benchmark: the mean of the top-k qualified
    // values (k = max(MIN, PCT of the pool)) instead of the single
    // all-time best, so one historical outlier can't deflate everyone.
    TOP_K_MIN: 3, TOP_K_PCT: 0.10,
    // Smooth confidence (Hill curve): inns² / (inns² + H²).
    // H innings = 50% trust; ~30 innings ≈ 90%. No hard step anywhere.
    CONF_HALF_INNINGS: 10,
    // Smooth experience: 100 × min(1, (inns/FULL)^GAMMA). Tracks the old
    // PDF tier table closely but with no jumps between tiers.
    EXP_FULL_INNINGS: 50, EXP_GAMMA: 1.3,
    // Final blend (sums to 10 → 0-1000 with the 100 base). Form is up
    // vs the PDF (3 → 3.5) and career down (5 → 4.5): career itself is
    // already recency-decayed, so current impact leads the rating.
    WEIGHTS: { career: 4.5, form: 3.5, ach: 1, exp: 1 },
  };

  // Qualification for the official lists (per the PDF for batting;
  // bowling mirrors it) - based on RAW career totals, so nobody is
  // disqualified by decay. Unqualified players still accumulate ratings
  // internally but are not shown.
  const QUAL = {
    batting: { innings: 10, runs: 100 },
    bowling: { innings: 10, wickets: 10 },
  };

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

  // Exponential recency decay: 1.0 now, 0.5 one half-life ago, 0.25 two...
  const decay = (seasonsAgo, halfLife) => Math.pow(0.5, Math.max(0, seasonsAgo) / halfLife);

  // Adaptive benchmarks: the mean of the k best values in the pool.
  const topK = poolSize => Math.max(MODEL.TOP_K_MIN, Math.round(poolSize * MODEL.TOP_K_PCT));
  function benchHi(values, k) {
    const v = values.filter(x => isFinite(x)).sort((a, b) => b - a).slice(0, k);
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0;
  }
  function benchLo(values, k) { // "lower is better" pools (avg, economy)
    const v = values.filter(x => isFinite(x) && x > 0).sort((a, b) => a - b).slice(0, k);
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0;
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
  // columns/values just become 0 - a thinner weekly export still works.
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
    try { localStorage.setItem(KEY_HISTORY, JSON.stringify(h)); } catch (e) { /* full - history is rebuilt from CSVs anyway */ }
  }
  // Append/update one season snapshot; the rest of history is untouched.
  // `source` is "file" (baseline CSV fetched from the repo) or "import"
  // (weekly CSV uploaded by an admin/moderator on this device).
  function mergeSeason(history, id, order, players, importedAt, source) {
    history.seasons[id] = { id, order, importedAt, source: source || "file", players };
    return history;
  }

  // Manifest ∪ history, sorted oldest → newest (for the import season picker).
  function knownSeasons(history) {
    const map = new Map();
    SEASONS.forEach(s => map.set(s.id, { id: s.id, order: s.order }));
    Object.values((history || loadHistory()).seasons || {}).forEach(s => map.set(s.id, { id: s.id, order: s.order }));
    return [...map.values()].sort((a, b) => a.order - b.order);
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

  // Recency-decayed career aggregates: every season's counting stats are
  // scaled by the career half-life before summing, and the rates (average,
  // strike rate, economy, dot%) are then computed from the DECAYED
  // numerators and denominators. Recent seasons dominate the career view;
  // old ones fade smoothly instead of propping a rating up forever.
  // Achievement points decay the same way - a 2019 fifty is worth less
  // than last week's. (Raw totals still drive qualification + experience.)
  function decayedCareer(c, latestOrder) {
    const bat = { runs: 0, inns: 0, notOuts: 0, balls: 0 };
    const bowl = { wkts: 0, inns: 0, conceded: 0, balls: 0, dots: 0 };
    let achBat = 0, achBowl = 0;
    c.seasons.forEach(({ order, snap }) => {
      const w = decay(latestOrder - order, MODEL.HALF_LIFE_CAREER);
      bat.runs += w * snap.bat.runs; bat.inns += w * snap.bat.inns;
      bat.notOuts += w * snap.bat.notOuts; bat.balls += w * snap.bat.balls;
      bowl.wkts += w * snap.bowl.wkts; bowl.inns += w * snap.bowl.inns;
      bowl.conceded += w * snap.bowl.conceded; bowl.balls += w * snap.bowl.balls;
      bowl.dots += w * snap.bowl.dots;
      achBat += w * (ACH_BAT.t30 * snap.bat.t30 + ACH_BAT.t50 * snap.bat.t50 + ACH_BAT.t100 * snap.bat.t100 + ACH_BAT.pom * snap.pom);
      achBowl += w * (ACH_BOWL.w3 * snap.bowl.w3 + ACH_BOWL.w5 * snap.bowl.w5 + ACH_BOWL.maiden * snap.bowl.maidens + ACH_BOWL.pom * snap.pom);
    });
    return { bat, bowl, achBat, achBowl };
  }

  // Career score: 50% volume + 30% average + 20% strike rate (PDF shape),
  // on DECAYED aggregates, normalized vs the adaptive top-k benchmark.
  function careerBatScore(b, P) {
    return 100 * (0.5 * ratioHi(b.runs, P.benchRuns)
                + 0.3 * ratioHi(batAvg(b), P.benchAvg)
                + 0.2 * ratioHi(batSR(b), P.benchSR));
  }
  // Bowling mirrors it: 50% wickets + 25% average + 15% economy + 10% dot%.
  // (Bowling SR is implicit: avg = economy × SR ÷ 6.)
  function careerBowlScore(b, P) {
    return 100 * (0.5 * ratioHi(b.wkts, P.benchWkts)
                + 0.25 * ratioLo(P.benchAvg, bowlAvg(b))
                + 0.15 * ratioLo(P.benchEco, bowlEco(b))
                + 0.10 * ratioHi(dotPct(b), P.benchDot));
  }

  // Same shapes applied to a single season row (vs per-season benchmarks) -
  // these feed the rolling form component.
  const seasonBatScore = (s, P) => 100 * (0.5 * ratioHi(s.bat.runs, P.benchRuns)
    + 0.3 * ratioHi(batAvg(s.bat), P.benchAvg) + 0.2 * ratioHi(batSR(s.bat), P.benchSR));
  const seasonBowlScore = (s, P) => 100 * (0.5 * ratioHi(s.bowl.wkts, P.benchWkts)
    + 0.25 * ratioLo(P.benchAvg, bowlAvg(s.bowl)) + 0.15 * ratioLo(P.benchEco, bowlEco(s.bowl))
    + 0.10 * ratioHi(dotPct(s.bowl), P.benchDot));

  // Rolling recent form: exponential decay by seasons-ago (short half-life
  // → the latest season carries roughly as much weight as ALL older ones
  // combined, so hot current form rises fast). The weighted mean is then
  // decayed again by how long ago the player last appeared, so inactive
  // players slide instead of freezing at their peak.
  function formScore(c, latestOrder, played, score) {
    const rows = c.seasons.filter(x => played(x.snap));
    if (!rows.length) return 0;
    let sum = 0, wsum = 0, lastOrder = 0;
    rows.forEach(x => {
      const w = decay(latestOrder - x.order, MODEL.HALF_LIFE_FORM);
      sum += w * score(x.snap); wsum += w;
      lastOrder = Math.max(lastOrder, x.order);
    });
    return (sum / wsum) * decay(latestOrder - lastOrder, MODEL.HALF_LIFE_FORM);
  }

  // Smooth curves - no tier steps.
  const expScore = inns => 100 * Math.min(1, Math.pow(Math.max(0, inns) / MODEL.EXP_FULL_INNINGS, MODEL.EXP_GAMMA));
  const confidence = inns => (inns * inns) / (inns * inns + MODEL.CONF_HALF_INNINGS * MODEL.CONF_HALF_INNINGS);

  // Final blend, shrunk toward the 100 base by the smooth confidence
  // factor and clamped to the 0-1000 scale.
  function finalRating(career, form, ach, exp, inns) {
    const W = MODEL.WEIGHTS;
    const raw = 100 + W.career * career + W.form * form + W.ach * ach + W.exp * exp;
    return clamp(Math.round(100 + confidence(inns) * (raw - 100)), 0, 1000);
  }

  // Full recalculation from history → dated ranking snapshot.
  function computeAll(history, dateStr) {
    const { careers, latestOrder } = buildCareers(history);
    if (!careers.length) return { date: dateStr, batting: [], bowling: [], allrounder: [] };

    const batQ = careers.filter(batQualified);
    const bowlQ = careers.filter(bowlQualified);

    // Decayed (recency-weighted) aggregates, once per career.
    const D = new Map(careers.map(c => [c.key, decayedCareer(c, latestOrder)]));

    // Adaptive career benchmarks: mean of the top-k DECAYED values among
    // qualified players (top-k, not the single all-time best).
    const kBat = topK(batQ.length), kBowl = topK(bowlQ.length);
    const batPool = {
      benchRuns: benchHi(batQ.map(c => D.get(c.key).bat.runs), kBat),
      benchAvg: benchHi(batQ.map(c => batAvg(D.get(c.key).bat)), kBat),
      benchSR: benchHi(batQ.map(c => batSR(D.get(c.key).bat)), kBat),
      benchAch: benchHi(batQ.map(c => D.get(c.key).achBat), kBat),
    };
    const bowlPool = {
      benchWkts: benchHi(bowlQ.map(c => D.get(c.key).bowl.wkts), kBowl),
      benchAvg: benchLo(bowlQ.map(c => bowlAvg(D.get(c.key).bowl)), kBowl),
      benchEco: benchLo(bowlQ.map(c => bowlEco(D.get(c.key).bowl)), kBowl),
      benchDot: benchHi(bowlQ.map(c => dotPct(D.get(c.key).bowl)), kBowl),
      benchAch: benchHi(bowlQ.map(c => D.get(c.key).achBowl), kBowl),
    };
    // Season benchmarks for the form component: top-k single-season
    // figures across all played rows (any era - form is era-relative).
    const allSeasonRows = careers.flatMap(c => c.seasons.map(x => x.snap));
    const batRows = allSeasonRows.filter(s => s.bat.inns > 0);
    const bowlRows = allSeasonRows.filter(s => s.bowl.inns > 0);
    const kBatS = topK(batRows.length), kBowlS = topK(bowlRows.length);
    const seasonBatPool = {
      benchRuns: benchHi(batRows.map(s => s.bat.runs), kBatS),
      benchAvg: benchHi(batRows.map(s => batAvg(s.bat)), kBatS),
      benchSR: benchHi(batRows.map(s => batSR(s.bat)), kBatS),
    };
    const seasonBowlPool = {
      benchWkts: benchHi(bowlRows.map(s => s.bowl.wkts), kBowlS),
      benchAvg: benchLo(bowlRows.map(s => bowlAvg(s.bowl)), kBowlS),
      benchEco: benchLo(bowlRows.map(s => bowlEco(s.bowl)), kBowlS),
      benchDot: benchHi(bowlRows.map(s => dotPct(s.bowl)), kBowlS),
    };

    const ratings = new Map(); // key → { bat, bowl }
    careers.forEach(c => {
      const d = D.get(c.key);
      const bat = finalRating(
        careerBatScore(d.bat, batPool),
        formScore(c, latestOrder, s => s.bat.inns > 0, s => seasonBatScore(s, seasonBatPool)),
        100 * ratioHi(d.achBat, batPool.benchAch),
        expScore(c.bat.inns),
        c.bat.inns);
      const bowl = finalRating(
        careerBowlScore(d.bowl, bowlPool),
        formScore(c, latestOrder, s => s.bowl.inns > 0, s => seasonBowlScore(s, seasonBowlPool)),
        100 * ratioHi(d.achBowl, bowlPool.benchAch),
        expScore(c.bowl.inns),
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
        // A manual weekly import is fresher than the committed baseline CSV -
        // don't clobber it on reload. (Committing the new CSV replaces it for
        // everyone; a newer manual import replaces it on this device.)
        const cur = history.seasons[se.id];
        if (cur && cur.source === "import") return;
        try {
          const res = await fetch(encodeURI(se.file), { cache: "no-store" });
          if (!res.ok) return;
          const players = parseSeasonCSV(await res.text());
          if (players.length) { mergeSeason(history, se.id, se.order, players, today(), "file"); fetched++; }
        } catch (e) { /* offline / file:// - stored history covers us */ }
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

    // Seasons for the import picker: known ones plus the next new id.
    getSeasons() {
      const seasons = knownSeasons();
      const nextOrder = seasons.length ? seasons[seasons.length - 1].order + 1 : 1;
      return { seasons, next: { id: "S" + nextOrder, order: nextOrder } };
    },

    // Admin/moderator weekly import: one season's cumulative CSV export.
    // Updates that season in the local history (never touches the others),
    // recalculates from full history, and notifies the UI. Synchronous.
    importSeasonCSV(seasonId, csvText) {
      const players = parseSeasonCSV(String(csvText || ""));
      if (!players.length) return { ok: false, error: "No player rows found in that CSV" };
      const history = loadHistory();
      const known = knownSeasons(history);
      const existing = known.find(s => s.id === seasonId);
      const order = existing ? existing.order : (known.length ? known[known.length - 1].order + 1 : 1);
      mergeSeason(history, seasonId, order, players, today(), "import");
      saveHistory(history);
      state.snapshot = computeAll(history, today());
      saveSnapshot(state.snapshot);
      state.status = "ready";
      emit();
      return { ok: true, count: players.length, seasonId };
    },
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
