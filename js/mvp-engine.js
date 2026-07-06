/* ============================================================
   HCCL Season MVP engine  (pure logic - no DOM, no Firebase)

   Three responsibilities, all pure functions on window.HCCLMvp:
     1. parseLines(lines)   - turn the text lines of a STUMPS match
                              report PDF into a structured match object.
     2. computeMatch(match) - apply the Hybrid MVP model (70% fixed
                              points + 30% contribution impact) to give
                              every player a Final Match MVP score.
     3. seasonTable(matches)- sum Final Match MVP scores across matches
                              into the Season MVP leaderboard.

   Everything the model uses is in CONFIG below, so the point tables and
   weights can be tuned in one place without touching the logic.

   Node-testable: it binds to globalThis when window is absent.
   ============================================================ */
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;

  /* ==================================================================== *
   *  SCORING METHOD - LOCKED (HCCL Season MVP, Hybrid Model)             *
   *  The single source of truth. Every value below appears in CONFIG;    *
   *  change a number here AND in CONFIG together - never one alone.       *
   * -------------------------------------------------------------------- *
   *  FINAL = 0.70 x Fixed  +  0.30 x Impact                              *
   *  Season MVP = Sum(Final over matches);  Efficiency = Season / matches *
   *                                                                      *
   *  FIXED (70%) = Batting + Bowling + Match bonuses                     *
   *    Batting - Runs:  0=-5  1-10=0  11-20=+5  21-30=+12  31-40=+20     *
   *                     41-50=+30  51-60=+40  61+=+50                    *
   *              SR:    <80=-5  80-100=0  101-120=+3  121-150=+6         *
   *                     151-180=+10  181-220=+15  >220=+20               *
   *              Not out +5;  Winning not out +10 (extra);              *
   *              Highest scorer of team +5;  of match +10                *
   *    Bowling - Wkts:  0=0  1=+10  2=+22  3=+38  4=+55  5(+)=+75         *
   *              Econ:  >12=-5  10-12=0  8-10=+5  6-8=+10  4-6=+15  <4=+20 *
   *              Dot balls: +0.5 each, capped +10;  Maiden +8 each;      *
   *              Best bowling figures in match +5                        *
   *    Match  -  Winning team +5 (EVERY winning-team player);  POTM +15  *
   *                                                                      *
   *  IMPACT (30%), each contribution as a percentage number (ratio x100):*
   *    battingC  = runs / teamTotal        x 100  *
   *    bowlingC  = wickets / oppWicketsLost x 100)    *
   *    matchResult = 100 if the player's team won, else 0                *
   *    Impact   = 0.45*battingC + 0.45*bowlingC + 0.10*matchResult       *
   *                                                                      *
   *  EDGE RULES: a player who did NOT bat (0 balls) scores 0 batting; a  *
   *  player who did NOT bowl (0 overs) scores 0 bowling; the +5 team-win  *
   *  bonus is still awarded to every player on the winning team.          *
   * ==================================================================== */
  const CONFIG = {
    // Final = fixed*0.70 + impact*0.30
    weights: { fixed: 0.70, impact: 0.30 },

    // --- Fixed Points: batting ---
    // Runs -> points. Bands are [minInclusive, maxInclusive, points].
    battingRuns: [
      [0, 0, -5], [1, 10, 0], [11, 20, 5], [21, 30, 12],
      [31, 40, 20], [41, 50, 30], [51, 60, 40], [61, Infinity, 50],
    ],
    // Strike-rate bonus. Bands are [maxInclusive, points]; first match wins.
    strikeRate: [
      [79.999, -5], [100, 0], [120, 3], [150, 6], [180, 10], [220, 15], [Infinity, 20],
    ],
    notOut: 5,
    winningNotOut: 10,     // not out AND team won (in addition to notOut)
    topScorerTeam: 5,
    topScorerMatch: 10,

    // --- Fixed Points: bowling ---
    // Wickets -> points (5+ capped at the last entry).
    bowlingWickets: [0, 10, 22, 38, 55, 75],
    // Economy bonus. Bands are [maxInclusive, points]; first match wins.
    economy: [
      [3.999, 20], [6, 15], [8, 10], [10, 5], [12, 0], [Infinity, -5],
    ],
    dotPerBall: 0.5,
    dotCap: 10,
    maidenEach: 8,
    bestBowling: 5,        // best figures in the match

    // --- Fixed Points: match bonuses ---
    winningTeam: 5,
    playerOfTheMatch: 15,

    // --- Impact (30%): contributions as percentage numbers (ratio x100),
    // matchResult = 100 for a win / 0 for a loss, then weighted 0.45/0.45/0.10.
    // See the SCORING METHOD block above. ---
    impact: { batting: 0.45, bowling: 0.45, result: 0.10 },

    // Optional PDF-name -> display-name aliases (e.g. "Sasi18": "Sasindu
    // Madushan"). Applied on parse so the same player aggregates correctly
    // across matches even if STUMPS shows a nickname. Fill in later.
    aliases: {
      // "Sasi18": "SASINDU MADUSHAN",
    },
  };

  /* ------------------------------- utils --------------------------- */
  const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const int = v => { const n = parseInt(v, 10); return isFinite(n) ? n : 0; };
  // Strip captain / keeper markers and normalise whitespace.
  function cleanName(raw) {
    let s = String(raw || "").replace(/\s*\((?:c|wk|c\/wk|vc)\)\s*$/i, "").trim();
    s = s.replace(/\s{2,}/g, " ");
    const alias = CONFIG.aliases[s] || CONFIG.aliases[s.toLowerCase()];
    return alias || s;
  }
  const keyOf = s => cleanName(s).toLowerCase();

  function bandPoints(bands, value) {
    for (const [max, pts] of bands) if (value <= max) return pts;
    return bands.length ? bands[bands.length - 1][1] : 0;
  }
  function rangePoints(ranges, value) {
    for (const [lo, hi, pts] of ranges) if (value >= lo && value <= hi) return pts;
    return 0;
  }

  /* =====================  1. PARSE  ===================== */
  // Regexes tuned to the STUMPS "Match Report" export. The headers can vary
  // slightly between exports, so we accept optional "Batting" / "Bowling"
  // prefixes and still parse the same scorecard rows.
  const RE_BAT_HEAD = /^(.+?)\s+(?:Batting\s+)?R\s+B\s+4s\s+6s\s+SR$/i;
  const RE_BOWL_HEAD = /^(?:Bowler|.+?)\s+(?:Bowling\s+)?O\s+M\s+R\s+W\s+Eco/i;
  const RE_BAT_ROW = /^(.+?)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)$/;
  const RE_BOWL_ROW = /^(.+?)\s+(\d+(?:\.\d+)?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/;
  const RE_TOTAL = /\bTotal\s+(\d+)\s*\/\s*(\d+)/i;
  const RE_WON = /\bwon by\b/i;                 // just detects the result line
  const RE_POTM_LABEL = /Player Of The Match/i;
  // Stop scanning for the POTM value once the Match Information block begins.
  const RE_POTM_STOP = /Match Information|Tournament|^Club\b|Match Title|Match Format|^Playing\b|^Overs\b|^Venue\b|Toss\b|Scorer\b|Match ID|Date & Time/i;
  const RE_DISMISS = /\s+(?:not out\b|run out\b|retired\b|lbw\b|st\s|c\s|b\s)/i;

  // Winner of a completed LMS match = the side with the higher total. On a tie
  // (or missing totals) fall back to the team named in the "won by" line.
  function winnerFromTotals(teams, fallbackLine) {
    const list = (teams || []).filter(t => t && t.name);
    if (!list.length) return "";
    let best = list[0];
    list.forEach(t => { if ((t.total || 0) > (best.total || 0)) best = t; });
    const tied = list.filter(t => (t.total || 0) === (best.total || 0));
    if (tied.length === 1) return best.name;
    if (fallbackLine) {
      const lower = String(fallbackLine).toLowerCase();
      let pick = "", pickIdx = -1;
      list.forEach(t => { const i = lower.lastIndexOf(t.name.toLowerCase()); if (i > pickIdx) { pickIdx = i; pick = t.name; } });
      if (pick) return pick;
    }
    return best.name;
  }
  // POTM must be one of the players: return the first candidate that names a
  // parsed player (whole-name token match), else "". Team names never match.
  function resolvePotm(candidates, playerList) {
    for (const c of (candidates || [])) {
      const hay = " " + String(c == null ? "" : c).toLowerCase().replace(/\s+/g, " ").trim() + " ";
      for (const p of (playerList || [])) {
        const k = keyOf(p.name);
        if (k && hay.includes(" " + k + " ")) return p.name;
      }
    }
    return "";
  }
  // Display-safe winner + POTM for a stored/parsed match (self-heals old docs).
  function matchInfo(match) {
    return {
      winner: winnerFromTotals(match && match.teams, (match && match.winner) || ""),
      potm: resolvePotm([match && match.potm], (match && match.players) || []),
    };
  }

  function parseLines(lines) {
    const players = new Map();       // key -> player record
    const battingTeams = [];         // ordered unique batting-team names
    const teamTotals = {};           // team -> { total, wickets }
    let mode = null;                 // 'batting' | 'bowling' | null
    let curTeam = null;              // current batting team
    let matchId = "", title = "", dateText = "", winner = "", potm = "";
    let wonByLine = "";              // raw "... won by ..." line (winner tie fallback)
    let collectingPotm = 0;          // lines left to scan after the POTM label
    const potmCandidates = [];       // POTM name candidates, resolved vs players later
    const bowlContext = [];          // {rec, battingAgainst} to resolve team later

    const getPlayer = (name, team) => {
      const k = keyOf(name);
      if (!players.has(k)) {
        players.set(k, {
          name: cleanName(name), team: team || "",
          batting: { runs: 0, balls: 0, fours: 0, sixes: 0, sr: 0, out: true, batted: false },
          bowling: { overs: 0, maidens: 0, runs: 0, wickets: 0, eco: 0, dots: 0, bowled: false },
        });
      }
      const p = players.get(k);
      if (team && !p.team) p.team = team;
      return p;
    };

    for (let raw of lines) {
      const line = String(raw || "").replace(/\s+/g, " ").trim();
      if (!line) continue;

      // ---- global anchors (independent of table mode) ----
      if (!matchId) { const m = line.match(/Match ID\s+(\S+)/i); if (m) matchId = m[1]; }
      if (!title) { const m = line.match(/Match Title\s+(.+)/i); if (m) title = m[1].trim(); }
      if (!dateText) { const m = line.match(/Date & Time\s+(.+)/i); if (m) dateText = m[1].trim(); }
      if (!wonByLine && RE_WON.test(line)) wonByLine = line;
      const tot = line.match(RE_TOTAL);
      if (tot && curTeam) teamTotals[curTeam] = { total: int(tot[1]), wickets: int(tot[2]) };
      if (/Over Comparison/i.test(line)) { mode = null; continue; }

      // ---- table headers / boundaries ----
      const bh = line.match(RE_BAT_HEAD);
      if (bh) {
        curTeam = cleanName(bh[1]);
        if (!battingTeams.includes(curTeam)) battingTeams.push(curTeam);
        mode = "batting";
        continue;
      }
      if (RE_BOWL_HEAD.test(line)) { mode = "bowling"; continue; }
      if (/^Extras\b/i.test(line)) { mode = null; continue; }

      // ---- data rows ----
      if (mode === "batting") {
        const m = line.match(RE_BAT_ROW);
        if (m) {
          const name = m[1].split(RE_DISMISS)[0];
          const p = getPlayer(name, curTeam);
          p.batting.runs = int(m[2]); p.batting.balls = int(m[3]);
          p.batting.fours = int(m[4]); p.batting.sixes = int(m[5]);
          p.batting.sr = num(m[6]);
          p.batting.out = !/not out/i.test(m[1]);
          p.batting.batted = true;
          continue;
        }
      } else if (mode === "bowling") {
        const m = line.match(RE_BOWL_ROW);
        if (m) {
          const p = getPlayer(m[1], "");           // team resolved after parse
          p.bowling.overs = num(m[2]); p.bowling.maidens = int(m[3]);
          p.bowling.runs = int(m[4]); p.bowling.wickets = int(m[5]);
          p.bowling.eco = num(m[6]); p.bowling.dots = int(m[7]);
          p.bowling.bowled = true;
          bowlContext.push({ p, battingAgainst: curTeam });
          continue;
        }
      }

      // Player of the Match: collect the label's inline value (if any) + a few
      // following lines; the real player is resolved against the parsed players
      // after the loop (so a team name the 2-column layout drops in here loses).
      if (RE_POTM_LABEL.test(line)) {
        const inline = line.replace(RE_POTM_LABEL, "").replace(/^[\s:._-]+/, "").trim();
        if (inline) potmCandidates.push(inline);
        collectingPotm = 6;
        continue;
      }
      if (collectingPotm > 0) {
        if (RE_POTM_STOP.test(line)) collectingPotm = 0;
        else { potmCandidates.push(line); collectingPotm--; }
      }
    }

    // Resolve each bowler's team = the team that was NOT batting against them.
    const other = t => battingTeams.find(x => x !== t) || "";
    bowlContext.forEach(({ p, battingAgainst }) => {
      if (!p.team) p.team = other(battingAgainst);
    });

    const teams = battingTeams.map(name => ({
      name,
      total: (teamTotals[name] || {}).total || 0,
      wickets: (teamTotals[name] || {}).wickets || 0,
    }));

    // Winner from totals (the 2-column header text is unreliable); POTM = the
    // first candidate line that names a parsed player.
    winner = winnerFromTotals(teams, wonByLine);
    potm = resolvePotm(potmCandidates, Array.from(players.values()));

    let ts = Date.parse(dateText);
    if (!isFinite(ts)) ts = 0;

    return {
      matchId: matchId || "", title, dateText, ts,
      teams, winner, potm,
      players: Array.from(players.values()),
    };
  }

  /* =====================  2. COMPUTE (one match)  ===================== */
  function battingPoints(bat, ctx) {
    if (!bat.batted || bat.balls <= 0) return 0; // didn't face a ball -> no penalty/bonus
    let pts = rangePoints(CONFIG.battingRuns, bat.runs);
    pts += bandPoints(CONFIG.strikeRate, bat.sr);
    if (!bat.out) { pts += CONFIG.notOut; if (ctx.won) pts += CONFIG.winningNotOut; }
    if (ctx.topTeam) pts += CONFIG.topScorerTeam;
    if (ctx.topMatch) pts += CONFIG.topScorerMatch;
    return pts;
  }
  function bowlingPoints(bowl, ctx) {
    if (!bowl.bowled || bowl.overs <= 0) return 0;
    const w = Math.min(bowl.wickets, CONFIG.bowlingWickets.length - 1);
    let pts = CONFIG.bowlingWickets[w];
    pts += bandPoints(CONFIG.economy, bowl.eco);
    pts += Math.min(CONFIG.dotCap, bowl.dots * CONFIG.dotPerBall);
    pts += bowl.maidens * CONFIG.maidenEach;
    if (ctx.bestBowling) pts += CONFIG.bestBowling;
    return pts;
  }

  function computeMatch(match) {
    const players = (match.players || []).map(p => ({
      ...p,
      batting: { ...p.batting }, bowling: { ...p.bowling },
    }));
    const totals = {};
    (match.teams || []).forEach(t => { totals[t.name] = t; });
    // Self-heal older docs: winner from totals; accept a stored POTM only if it
    // names a real player (older docs may hold a team name here).
    const winner = winnerFromTotals(match.teams, match.winner || "");
    const potmKey = keyOf(resolvePotm([match.potm], players));

    // Highest scorer per team + overall (by runs).
    const teamMax = {}; let matchMax = -1;
    players.forEach(p => {
      const r = p.batting.runs;
      if (r > (teamMax[p.team] || -1)) teamMax[p.team] = r;
      if (r > matchMax) matchMax = r;
    });
    // Best bowling figures in the match: most wickets, then fewest runs.
    let best = null;
    players.forEach(p => {
      if (!p.bowling.bowled || p.bowling.overs <= 0) return;
      if (!best || p.bowling.wickets > best.bowling.wickets ||
        (p.bowling.wickets === best.bowling.wickets && p.bowling.runs < best.bowling.runs)) best = p;
    });

    const rows = players.map(p => {
      const won = !!winner && p.team === winner;
      const oppTeam = (match.teams || []).map(t => t.name).find(n => n !== p.team) || "";
      const teamTotal = (totals[p.team] || {}).total || 0;
      const oppWkts = (totals[oppTeam] || {}).wickets || 0;
      const isPotm = potmKey && keyOf(p.name) === potmKey;

      // ---- Fixed points (70%) ----
      const batCtx = {
        won,
        topTeam: p.batting.batted && p.batting.runs === teamMax[p.team] && p.batting.runs > 0,
        topMatch: p.batting.batted && p.batting.runs === matchMax && p.batting.runs > 0,
      };
      const bowlCtx = { bestBowling: best && keyOf(best.name) === keyOf(p.name) };
      let fixed = battingPoints(p.batting, batCtx) + bowlingPoints(p.bowling, bowlCtx);
      if (won) fixed += CONFIG.winningTeam;
      if (isPotm) fixed += CONFIG.playerOfTheMatch;

      // ---- Contribution impact (30%), each term on a 0-100 scale ----
      const batContribution = teamTotal > 0 ? (p.batting.runs / teamTotal) * 100 : 0;
      const bowlContribution = oppWkts > 0 ? (p.bowling.wickets / oppWkts) * 100 : 0;
      const resultPct = won ? 100 : 0;
      const impact = CONFIG.impact.batting * batContribution
        + CONFIG.impact.bowling * bowlContribution
        + CONFIG.impact.result * resultPct;

      const final = CONFIG.weights.fixed * fixed + CONFIG.weights.impact * impact;

      return {
        name: p.name, team: p.team,
        runs: p.batting.runs, balls: p.batting.balls, sr: p.batting.sr, notOut: !p.batting.out && p.batting.batted,
        wickets: p.bowling.wickets, overs: p.bowling.overs, eco: p.bowling.eco,
        potm: isPotm, won,
        fixed: round1(fixed), impact: round1(impact), final: round1(final),
      };
    });

    rows.sort((a, b) => b.final - a.final);
    rows.forEach((r, i) => { r.pos = i + 1; });
    return rows;
  }

  /* =====================  3. SEASON leaderboard  ===================== */
  // matches: [{ ...parsed match... }]. Sums Final Match MVP across matches.
  function seasonTable(matches) {
    const agg = new Map();
    (matches || []).forEach(match => {
      const rows = computeMatch(match);
      rows.forEach(r => {
        const k = keyOf(r.name);
        if (!agg.has(k)) agg.set(k, { name: r.name, team: r.team, total: 0, matches: 0 });
        const a = agg.get(k);
        a.total += r.final; a.matches += 1;
        if (r.team) a.team = r.team;
      });
    });
    const out = Array.from(agg.values()).map(a => ({
      name: a.name, team: a.team,
      matches: a.matches,
      total: round1(a.total),
      efficiency: round1(a.matches ? a.total / a.matches : 0),
    }));
    out.sort((x, y) => y.total - x.total || y.efficiency - x.efficiency);
    out.forEach((r, i) => { r.pos = i + 1; });
    return out;
  }

  function round1(n) { return Math.round(n * 10) / 10; }

  root.HCCLMvp = { parseLines, computeMatch, seasonTable, matchInfo, CONFIG };
})();
