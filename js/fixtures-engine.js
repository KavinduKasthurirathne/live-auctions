/* ============================================================
   HCCL Fixtures & Results engine  (pure logic - no DOM, no Firebase)

   Everything the Fixtures & Results tab needs that isn't UI:
     1. deriveResult(parsed, match) - turn a parsed STUMPS match report
        (from HCCLMvp.parseLines) into this app's resultData:
        winner, result type, margin, scores, overs, summary.
     2. standings(matches, teams)   - league table from completed matches.
     3. Shared helpers: status list, formats, over/ball math, team-name
        matching between STUMPS text and our team records.

   The points system lives in CONFIG.points - change it there and both the
   table and the tooltips follow. Node-testable: binds to globalThis when
   window is absent.
   ============================================================ */
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;

  const CONFIG = {
    /* ---- POINTS SYSTEM (the one place to change it) ----
       Default league format: win 2, tie 1, loss 0. An abandoned / no-result
       match splits a point, as in most cricket leagues.
       A tie that goes to a SUPER OVER is not a tie for the league: the Super
       Over winner takes a full win (2) and the loser gets 0 - so the table
       shows W/L, not T. `tie` points only apply to a tie with NO Super Over.
       Adjust these numbers (or add a key + handle it in pointsFor) if the
       format changes. */
    points: { win: 2, tie: 1, loss: 0, abandoned: 1, superOverWin: 2, superOverLoss: 0 },

    // Abandoned matches still count as "played" in the table (they carry points).
    countAbandonedAsPlayed: true,

    // How many teams qualify for the playoffs. The standings draw a cut-off line
    // under this position (IPL-style top 4). Change it if the format changes.
    playoffCutoff: 4,

    // A team is all out one wicket short of its batting strength. Used to work
    // out "won by N wickets"; falls back to this when the squad size is unknown.
    defaultWicketsPerSide: 10,

    /* ---- TEST CHAMPIONSHIP (a completely separate points system) ----
       Applies ONLY to tournaments/matches flagged as Test. Limited-overs
       matches never touch any of this.
         WIN +12 · DRAW +6 · TIE +4 · LOSS +0
       Plus BONUS points, awarded PER INNINGS and independent of the result -
       a losing side still keeps whatever bonuses it earned:
         batting - innings runs >= 300 -> +2, else >= 200 -> +1
         bowling - opponent ALL OUT for <= 50 -> +2, else <= 100 -> +1
       Bands are [threshold, points]; the FIRST match wins, so keep them ordered
       from the most generous threshold down. */
    test: {
      points: { win: 12, draw: 6, tie: 4, loss: 0, abandoned: 0 },
      battingBonus: [[300, 2], [200, 1]],   // innings runs >= threshold
      bowlingBonus: [[50, 2], [100, 1]],    // opponent all out for <= threshold
    },
  };

  /* ---- MATCH STAGES ----
     `table: true` means results from that stage feed the points table. Only the
     group stage does: once the league phase is over, the playoffs decide the
     title, not the standings - so a Qualifier/Eliminator/Final win must NOT add
     points. Flip a flag here (or add a stage) if the format changes; the table,
     the form and the badges all read from this one list.
     The playoff names match the IPL-style bracket on the Home page. */
  const STAGES = [
    { id: "group", label: "Group Stage", short: "Group", table: true },
    { id: "qualifier1", label: "Qualifier 1", short: "Q1", table: false },
    { id: "eliminator", label: "Eliminator", short: "Elim", table: false },
    { id: "qualifier2", label: "Qualifier 2", short: "Q2", table: false },
    { id: "final", label: "Final", short: "Final", table: false },
    { id: "friendly", label: "Friendly / Warm-up", short: "Friendly", table: false },
  ];
  const DEFAULT_STAGE = "group";
  const stageOf = m => (m && m.stage) || DEFAULT_STAGE;   // matches saved before stages existed = group
  const stageMeta = id => STAGES.find(s => s.id === id) || STAGES[0];
  // The single question the standings asks of a match.
  const countsForStandings = m => stageMeta(stageOf(m)).table === true;
  const isKnockout = m => !countsForStandings(m);

  const STATUSES = ["scheduled", "live", "completed", "postponed", "abandoned"];
  const STATUS_LABEL = {
    scheduled: "Scheduled", live: "Live", completed: "Completed",
    postponed: "Postponed", abandoned: "Abandoned",
  };
  const FORMATS = ["T10", "T20", "5 Overs", "6 Overs", "10 Overs", "Last Man Stands", "Custom"];
  // "draw" (an unfinished match) is offered for TEST matches only - it is a
  // different result from a "tie" (scores finish level) and scores differently.
  const RESULT_TYPES = ["runs", "wickets", "tie", "abandoned", "no-result"];
  const TEST_RESULT_TYPES = ["runs", "wickets", "innings", "draw", "tie", "abandoned"];
  /* Result types that NAME A WINNER. "innings" belongs here just as much as runs or
     wickets - an innings victory has a winner. Keep this as the single source of
     truth: callers that ask "is there a winner to record?" must use it rather than
     re-listing the types, or a new type silently loses its winner. */
  const DECISIVE_TYPES = ["runs", "wickets", "innings"];
  const isDecisiveResult = t => DECISIVE_TYPES.indexOf(t) >= 0;
  // A result that ENDS the match (nothing further will be played).
  const FINAL_TYPES = ["runs", "wickets", "innings", "draw", "tie", "abandoned", "no-result"];
  const isFinalResult = t => FINAL_TYPES.indexOf(t) >= 0;

  /* ---------------------------- utils ------------------------------ */
  const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const round2 = n => Math.round(n * 100) / 100;
  const norm = s => String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  /* Cricket overs are NOT decimals: "4.3" = 4 overs + 3 balls. Always convert to
     balls before doing arithmetic, or NRR comes out wrong. */
  function oversToBalls(overs) {
    const o = num(overs);
    const whole = Math.floor(o);
    // Guard a malformed "4.7" by clamping the ball part to 5.
    const balls = Math.min(5, Math.round((o - whole) * 10));
    return whole * 6 + balls;
  }
  function ballsToOvers(balls) {
    const b = Math.max(0, Math.round(num(balls)));
    return `${Math.floor(b / 6)}.${b % 6}`;
  }

  /* ======================= OVER QUOTA / OFFICIAL NRR =======================
     Official ICC/IPL rule: a side bowled out before using its full quota of overs
     is charged the FULL QUOTA in the NRR calculation, not the overs it actually
     faced. Otherwise getting skittled would flatter your run rate.

     Rather than detect "all out" (which needs the squad size and gets murky under
     Last Man Stands), the rule reduces to something format-agnostic:

       • the side batting FIRST  -> always the full quota
         (bowled out early or batted it out: either way the answer is the quota)
       • the side batting SECOND -> the ACTUAL overs if it WON the chase,
         otherwise the full quota
         (a chasing side only stops early because it won, or was bowled out)

     Needs just three things: the quota, who batted first, and who won.
     If the quota is unknown we fall back to the actual overs faced (the old
     behaviour) rather than publish a wrong number. */

  // Pull the quota out of a free-text format label: "T10"->10, "10 Overs"->10.
  // "Last Man Stands" / "Custom" have no number -> 0 (unknown).
  function oversFromFormat(format) {
    const m = String(format == null ? "" : format).match(/(\d+(?:\.\d+)?)/);
    return m ? num(m[1]) : 0;
  }
  // The match's own quota wins; otherwise fall back to the format label.
  function quotaBallsOf(match) {
    if (!match) return 0;
    const rd = match.resultData || {};
    const overs = num(match.oversPerSide) || num(rd.oversPerSide) || oversFromFormat(match.format);
    return overs > 0 ? Math.round(overs * 6) : 0;
  }
  // Which side batted first: "home" | "away" | "". Prefer what the import stored;
  // otherwise infer from scorecardData.teams - that array is in BATTING order, so
  // teams[0] batted first. This is what lets already-imported matches get the
  // official treatment without being re-imported.
  function battedFirstSide(match, teams) {
    const rd = (match && match.resultData) || {};
    if (rd.battedFirstSide === "home" || rd.battedFirstSide === "away") return rd.battedFirstSide;
    const sc = match && match.scorecardData;
    const first = sc && sc.teams && sc.teams[0] && sc.teams[0].name;
    if (!first) return "";
    // Match the STUMPS name against this match's home/away sides.
    const home = (rd.home && rd.home.name) || "";
    const away = (rd.away && rd.away.name) || "";
    if (home && norm(home) === norm(first)) return "home";
    if (away && norm(away) === norm(first)) return "away";
    const list = teams || [];
    const t = findTeam(first, list);
    if (t && match.homeTeamId && t.id === match.homeTeamId) return "home";
    if (t && match.awayTeamId && t.id === match.awayTeamId) return "away";
    return "";
  }
  // Effective balls for one side's innings, per the rule above.
  function nrrBallsFor(match, side, teams) {
    const rd = (match && match.resultData) || {};
    const inn = rd[side] || {};
    const actual = num(inn.balls);
    const quota = quotaBallsOf(match);
    if (!quota) return actual;                       // unknown quota -> old behaviour
    const first = battedFirstSide(match, teams);
    if (!first) return Math.min(actual, quota) || actual;  // unknown order -> be conservative
    if (side === first) return quota;                // batted first -> always the quota
    // Batted second: actual overs only if it actually won the chase.
    const wonId = effectiveWinnerId(match);
    const myId = side === "home" ? match.homeTeamId : match.awayTeamId;
    const chasedAndWon = wonId && myId && wonId === myId;
    return chasedAndWon ? Math.min(actual, quota) : quota;
  }

  /* Match a STUMPS team name ("SUPER FIRE DRAGONS") to one of our team records.
     Exact-normalised first, then a containment fallback for minor spelling drift. */
  function findTeam(name, teams) {
    const n = norm(name);
    if (!n) return null;
    const list = teams || [];
    let hit = list.find(t => norm(t.name) === n);
    if (hit) return hit;
    hit = list.find(t => { const tn = norm(t.name); return tn && (tn.includes(n) || n.includes(tn)); });
    return hit || null;
  }

  /* ====================== TEST CHAMPIONSHIP =============================
     A Test match gives each side TWO innings and is decided on AGGREGATE.
     It uses its own points table (12/6/4/0 + per-innings bonuses) and never
     shows net run rate. Everything here is inert for limited-overs matches. */

  // Is this match played under Test rules? The match's own flag wins; otherwise
  // inherit the tournament's setting (series.js), then fall back to the report.
  function isTestMatch(match) {
    if (!match) return false;
    if (match.isTest === true || match.isTest === false) return match.isTest;
    if (match.matchType === "test") return true;
    const S = root.HCCLSeries;
    if (S && typeof S.isTest === "function" && match.tournamentId) return !!S.isTest(match.tournamentId);
    if (S && typeof S.isTest === "function" && S.isTest()) return true;
    const rd = match.resultData;
    return !!(rd && rd.isTest);
  }

  // Innings list for a match, oldest first. Stored on resultData by the import.
  function inningsOf(match) {
    const rd = (match && match.resultData) || {};
    const list = Array.isArray(rd.innings) ? rd.innings.slice() : [];
    return list.filter(i => i && i.played !== false);
  }

  function bandAward(bands, value, cmp) {
    for (const [threshold, pts] of bands) if (cmp(value, threshold)) return pts;
    return 0;
  }
  // Batting: >= threshold. Bowling: <= threshold AND the side was all out.
  const battingBonusFor = runs => bandAward(CONFIG.test.battingBonus, num(runs), (v, t) => v >= t);
  function bowlingBonusFor(oppInnings) {
    if (!oppInnings || !oppInnings.allOut) return 0;   // must be bowled out
    return bandAward(CONFIG.test.bowlingBonus, num(oppInnings.runs), (v, t) => v <= t);
  }

  // Total bonus a side earned in one match: its own batting innings + every
  // opposition innings it bowled out cheaply. Awarded regardless of the result.
  function bonusFor(match, sideKey) {
    const list = inningsOf(match);
    if (!list.length) return 0;
    let bonus = 0;
    list.forEach(inn => {
      if (inn.side === sideKey) bonus += battingBonusFor(inn.runs);
      else bonus += bowlingBonusFor(inn);          // we bowled in this innings
    });
    return bonus;
  }

  /* ---- Lead / trail / target ----
     Walks the innings IN PLAYED ORDER (so a follow-on needs no special case) and
     labels each from the point of view of the side that has just finished
     batting - the standard Test scorecard convention:
        A 250, B 300  -> "B lead by 50"
        A 250, B 150  -> "B trail by 100"
     Once three innings are done, the side batting last needs (lead + 1). */
  function inningsProgress(match, nameOf) {
    const list = inningsOf(match);
    const agg = { home: 0, away: 0 };
    const label = (k, n) => (typeof nameOf === "function" ? nameOf(k) : k) + " " + n;
    return list.map(inn => {
      const side = inn.side === "away" ? "away" : "home";
      const opp = side === "home" ? "away" : "home";
      agg[side] += num(inn.runs);
      const diff = agg[side] - agg[opp];
      return {
        ...inn, side,
        aggFor: agg[side], aggAgainst: agg[opp], diff,
        text: diff > 0 ? label(side, `lead by ${diff}`)
          : diff < 0 ? label(side, `trail by ${Math.abs(diff)}`)
            : "scores level",
      };
    });
  }
  // { side, runsNeeded } for the team batting last, or null when not applicable.
  // A target only exists while the match is STILL LIVE. A finished match has no
  // target - most importantly an innings victory, which ends the match with the
  // 4th innings never played even though only 3 innings are on the card.
  function targetOf(match, nameOf) {
    if (!match) return null;
    if (match.status === "completed") return null;
    const rd = match.resultData || {};
    if (isFinalResult(rd.resultType)) return null;   // the result already stands
    const rows = inningsProgress(match, nameOf);
    if (rows.length !== 3) return null;              // only meaningful before the 4th innings
    const last = rows[rows.length - 1];
    const chasing = last.diff > 0 ? (last.side === "home" ? "away" : "home") : last.side;
    const lead = Math.abs(last.diff);
    return { side: chasing, runsNeeded: lead + 1 };
  }

  /* --------------------------- SUPER OVER ---------------------------------
     A tied match may be decided by a Super Over. The scorecard still says the
     match TIED (that's the cricket truth, and the innings runs still feed NRR),
     but for the league the Super Over winner takes the win: W/L, never T.
     Shape: resultData.superOver = { winnerTeamId, winnerName, home:{runs,wickets},
     away:{runs,wickets} }. Super Over runs never touch NRR. */
  function superOverOf(match) {
    const so = match && match.resultData && match.resultData.superOver;
    return so && so.winnerTeamId ? so : null;
  }
  const hasSuperOver = m => !!superOverOf(m);
  // The team the league counts as the winner: Super Over winner if there was
  // one, otherwise whoever won in normal play. "" for a true tie / no result.
  function effectiveWinnerId(match) {
    const so = superOverOf(match);
    if (so) return so.winnerTeamId;
    const rd = match && match.resultData;
    return (rd && rd.winnerTeamId) || "";
  }

  /* ----------------- 1. parsed STUMPS match -> resultData ------------------ */
  // parsed : output of HCCLMvp.parseLines()
  // match  : our stored match ({ homeTeamId, awayTeamId, ... })
  // teams  : our team records, to map STUMPS names -> ids
  //
  // parsed.teams is in BATTING order, so parsed.teams[0] batted first - that's
  // what decides "won by runs" vs "won by wickets".
  function deriveResult(parsed, match, teams) {
    const pTeams = (parsed && parsed.teams) || [];
    const players = (parsed && parsed.players) || [];
    const first = pTeams[0] || null;
    const second = pTeams[1] || null;

    // Innings scores keyed by STUMPS team name: runs, wickets, and the balls
    // faced (= balls bowled at them by the OTHER side's bowlers).
    const inn = {};
    pTeams.forEach(t => {
      const ballsFaced = players
        .filter(p => p.bowling && p.bowling.bowled && norm(p.team) !== norm(t.name))
        .reduce((s, p) => s + oversToBalls(p.bowling.overs), 0);
      inn[norm(t.name)] = { name: t.name, runs: num(t.total), wickets: num(t.wickets), balls: ballsFaced };
    });

    // Batting strength -> wickets available (all out = strength - 1).
    const battedCount = teamName => players.filter(p =>
      norm(p.team) === norm(teamName) && p.batting && p.batting.batted).length;

    const isTest = !!(parsed && parsed.isTestReport);
    const parsedInnings = (parsed && parsed.innings) || [];

    let resultType = "no-result", winnerName = "", margin = 0;
    if (isTest && first && second) {
      // TEST: decided on the AGGREGATE of both innings, not a single innings.
      const a = inn[norm(first.name)], b = inn[norm(second.name)];
      const countOf = name => parsedInnings.filter(x => norm(x.team) === norm(name)).length;
      const aInns = countOf(first.name), bInns = countOf(second.name);
      const lastInn = parsedInnings[parsedInnings.length - 1];
      if (a.runs === b.runs) {
        resultType = "tie";
      } else {
        const leader = a.runs > b.runs ? first : second;
        const laggard = a.runs > b.runs ? second : first;
        const lead = Math.abs(a.runs - b.runs);
        winnerName = leader.name;
        // An innings victory: the loser batted twice (or was made to follow on)
        // and STILL trails, while the winner never needed a second innings.
        const leaderInns = norm(leader.name) === norm(first.name) ? aInns : bInns;
        const laggardInns = norm(laggard.name) === norm(first.name) ? aInns : bInns;
        if (leaderInns === 1 && laggardInns >= 2) {
          resultType = "innings"; margin = lead;
        } else if (lastInn && norm(lastInn.team) === norm(leader.name)) {
          // The winner batted last, so they chased the target down: wickets in hand.
          const strength = (parsed && parsed.playingPerSide)
            || battedCount(leader.name) || CONFIG.defaultWicketsPerSide + 1;
          resultType = "wickets";
          margin = Math.max(0, Math.max(1, strength - 1) - num(lastInn.wickets));
        } else {
          resultType = "runs"; margin = lead;
        }
      }
    } else if (first && second) {
      const a = inn[norm(first.name)], b = inn[norm(second.name)];
      if (a.runs === b.runs) {
        resultType = "tie";
      } else if (a.runs > b.runs) {
        // Team batting first defended: won by the run difference.
        resultType = "runs"; winnerName = first.name; margin = a.runs - b.runs;
      } else {
        // Team batting second chased: won by wickets in hand.
        const strength = battedCount(second.name) || CONFIG.defaultWicketsPerSide + 1;
        const available = Math.max(1, strength - 1);
        resultType = "wickets"; winnerName = second.name;
        margin = Math.max(0, available - b.wickets);
      }
    }

    const homeTeam = teams && match ? findTeamById(teams, match.homeTeamId) : null;
    const awayTeam = teams && match ? findTeamById(teams, match.awayTeamId) : null;
    // Map each innings onto home/away. Fall back to batting order when the
    // STUMPS names don't resolve (the admin can fix it in the confirm dialog).
    const pick = team => {
      if (team) {
        const k = Object.keys(inn).find(k2 => norm(inn[k2].name) === norm(team.name)
          || norm(team.name).includes(k2) || k2.includes(norm(team.name)));
        if (k) return inn[k];
      }
      return null;
    };
    const home = pick(homeTeam) || (first ? inn[norm(first.name)] : null) || blankScore();
    const away = pick(awayTeam) || (second ? inn[norm(second.name)] : null) || blankScore();

    const winnerTeam = winnerName ? findTeam(winnerName, teams || []) : null;

    // Which of OUR sides batted first (parsed.teams is in batting order). NRR needs
    // this to apply the full-quota rule; store it so it survives on the match doc.
    let firstSide = "";
    if (first) {
      if (homeTeam && norm(homeTeam.name) === norm(first.name)) firstSide = "home";
      else if (awayTeam && norm(awayTeam.name) === norm(first.name)) firstSide = "away";
      else if (home && home.name && norm(home.name) === norm(first.name)) firstSide = "home";
      else if (away && away.name && norm(away.name) === norm(first.name)) firstSide = "away";
    }

    // Label every innings home/away and keep them in PLAYED order, so the
    // standings bonuses and the lead/trail progression can walk them directly.
    const sideOfName = name => {
      if (homeTeam && norm(homeTeam.name) === norm(name)) return "home";
      if (awayTeam && norm(awayTeam.name) === norm(name)) return "away";
      if (home && home.name && norm(home.name) === norm(name)) return "home";
      if (away && away.name && norm(away.name) === norm(name)) return "away";
      return norm(first && first.name) === norm(name) ? firstSide || "home"
        : (firstSide === "home" ? "away" : "home");
    };
    const inningsOut = parsedInnings.map((x, i) => ({
      seq: x.seq || i + 1, order: x.order || 0, side: sideOfName(x.team), team: x.team,
      runs: num(x.runs), wickets: num(x.wickets), allOut: !!x.allOut, played: true,
    }));

    return {
      resultType,
      isTest,
      innings: inningsOut,
      playingPerSide: num(parsed && parsed.playingPerSide),
      battedFirstSide: firstSide,
      oversPerSide: num(parsed && parsed.oversPerSide),   // per-side quota from the report
      // Prefer OUR team's display name over the shouty STUMPS one ("ZYCO KINGS"),
      // so the summary reads like the rest of the site.
      winnerName: (winnerTeam && winnerTeam.name) || winnerName || "",
      winnerTeamId: winnerTeam ? winnerTeam.id : "",
      margin,
      potm: (parsed && parsed.potm) || "",
      home: { runs: home.runs, wickets: home.wickets, balls: home.balls, name: home.name || (homeTeam && homeTeam.name) || "" },
      away: { runs: away.runs, wickets: away.wickets, balls: away.balls, name: away.name || (awayTeam && awayTeam.name) || "" },
      summary: "", // filled by summarize() below so edits re-generate it
    };
  }
  function blankScore() { return { runs: 0, wickets: 0, balls: 0, name: "" }; }
  function findTeamById(teams, id) { return (teams || []).find(t => t.id === id) || null; }

  // "Zyco Kings won by 14 runs" / "… by 3 wickets" / "Abandoned" /
  // "Match tied" / "Match tied · Zyco Kings won the Super Over".
  function summarize(rd) {
    if (!rd) return "";
    const w = rd.winnerName || "";
    switch (rd.resultType) {
      case "runs": return w ? `${w} won by ${rd.margin} run${rd.margin === 1 ? "" : "s"}` : "";
      case "wickets": return w ? `${w} won by ${rd.margin} wicket${rd.margin === 1 ? "" : "s"}` : "";
      case "innings": return w ? `${w} won by an innings and ${rd.margin} run${rd.margin === 1 ? "" : "s"}` : "";
      case "draw": return "Match drawn";
      case "tie": {
        const so = rd.superOver;
        return so && so.winnerTeamId && so.winnerName
          ? `Match tied · ${so.winnerName} won the Super Over`
          : "Match tied";
      }
      case "abandoned": return "Match abandoned";
      default: return "No result";
    }
  }

  /* --------------------------- 2. STANDINGS -------------------------------- */
  function pointsFor(outcome) {
    const p = CONFIG.points;
    return outcome === "win" ? p.win
      : outcome === "tie" ? p.tie
        : outcome === "abandoned" ? p.abandoned
          : outcome === "superOverWin" ? p.superOverWin
            : outcome === "superOverLoss" ? p.superOverLoss
              : p.loss;
  }

  /* ---------------------- TEST standings ----------------------------------
     Columns: M W L D T PTS, sorted by PTS alone (no NRR, no tiebreakers).
       PTS = 12*W + 6*D + 4*T + 0*L + per-innings bonuses
     Kept in its own function so the limited-overs path below is untouched. */
  function testStandings(matches, teams) {
    const P = CONFIG.test.points;
    const rows = new Map();
    const seed = t => {
      if (!rows.has(t.id)) rows.set(t.id, {
        teamId: t.id, name: t.name, logo: t.logo || "",
        played: 0, wins: 0, losses: 0, draws: 0, ties: 0,
        resultPoints: 0, bonus: 0, points: 0, nrr: null, isTest: true,
      });
      return rows.get(t.id);
    };
    (teams || []).forEach(seed);

    (matches || []).forEach(m => {
      if (!m || m.status !== "completed" || !m.resultData) return;
      if (!countsForStandings(m)) return;              // knockouts still excluded
      const home = findTeamById(teams, m.homeTeamId);
      const away = findTeamById(teams, m.awayTeamId);
      if (!home || !away) return;
      const rd = m.resultData;
      const H = seed(home), A = seed(away);
      H.played++; A.played++;

      // Bonuses are earned regardless of the result - even by the losing side.
      const hb = bonusFor(m, "home"), ab = bonusFor(m, "away");
      H.bonus += hb; A.bonus += ab;

      const type = rd.resultType;
      if (type === "abandoned" || type === "no-result") {
        H.resultPoints += P.abandoned; A.resultPoints += P.abandoned;
      } else if (type === "draw") {
        H.draws++; A.draws++;
        H.resultPoints += P.draw; A.resultPoints += P.draw;
      } else {
        const wid = effectiveWinnerId(m);
        const decided = wid === home.id || wid === away.id;
        if (!decided || type === "tie") {
          H.ties++; A.ties++;
          H.resultPoints += P.tie; A.resultPoints += P.tie;
        } else {
          const winner = wid === home.id ? H : A, loser = wid === home.id ? A : H;
          winner.wins++; loser.losses++;
          winner.resultPoints += P.win; loser.resultPoints += P.loss;
        }
      }
    });

    const out = Array.from(rows.values()).map(r => ({ ...r, points: r.resultPoints + r.bonus }));
    out.sort((a, b) => b.points - a.points || b.wins - a.wins || a.name.localeCompare(b.name));
    out.forEach((r, i) => { r.pos = i + 1; });
    return out;
  }

  // matches: our stored match docs. teams: our team records.
  // Only COMPLETED, GROUP-STAGE matches with resultData count. Playoff results
  // (Qualifier / Eliminator / Final) are excluded entirely - no points AND no
  // runs, so they can't skew net run rate either.
  function standings(matches, teams, opts) {
    // A Test championship uses an entirely different points table.
    const testMode = opts && opts.test !== undefined
      ? !!opts.test
      : (matches || []).some(isTestMatch);
    if (testMode) return testStandings(matches, teams);
    return limitedStandings(matches, teams);
  }

  function limitedStandings(matches, teams) {
    const rows = new Map();
    const seed = t => {
      if (!rows.has(t.id)) rows.set(t.id, {
        teamId: t.id, name: t.name, logo: t.logo || "",
        played: 0, wins: 0, losses: 0, ties: 0, noResults: 0, points: 0,
        superOverWins: 0, superOverLosses: 0,   // subset of wins/losses, for the tooltip
        runsFor: 0, ballsFor: 0, runsAgainst: 0, ballsAgainst: 0, nrrKnown: true,
      });
      return rows.get(t.id);
    };
    (teams || []).forEach(seed);

    (matches || []).forEach(m => {
      if (!m || m.status !== "completed" || !m.resultData) return;
      if (!countsForStandings(m)) return;   // playoffs don't move the table
      const home = findTeamById(teams, m.homeTeamId);
      const away = findTeamById(teams, m.awayTeamId);
      if (!home || !away) return;
      const rd = m.resultData;
      const H = seed(home), A = seed(away);
      const abandoned = rd.resultType === "abandoned" || rd.resultType === "no-result";

      if (abandoned) {
        if (!CONFIG.countAbandonedAsPlayed) return;
        H.played++; A.played++;
        H.noResults++; A.noResults++;
        H.points += pointsFor("abandoned"); A.points += pointsFor("abandoned");
        return; // no runs/overs contribution
      }

      H.played++; A.played++;
      const so = superOverOf(m);
      // Guard: a winner id that names neither side is unusable - score it as a
      // tie rather than silently handing the win to the away team.
      const wid = effectiveWinnerId(m);
      const decided = wid === home.id || wid === away.id;
      if (!decided) {
        H.ties++; A.ties++;
        H.points += pointsFor("tie"); A.points += pointsFor("tie");
      } else if (rd.resultType === "tie" && !so) {
        // A true tie (no Super Over): a point each.
        H.ties++; A.ties++;
        H.points += pointsFor("tie"); A.points += pointsFor("tie");
      } else {
        // Decided in normal play, OR tied and settled by a Super Over. Either
        // way the league records a WIN and a LOSS - never a tie.
        const homeWon = wid === home.id;
        const winner = homeWon ? H : A, loser = homeWon ? A : H;
        winner.wins++; loser.losses++;
        if (so) {
          winner.superOverWins++; loser.superOverLosses++;
          winner.points += pointsFor("superOverWin"); loser.points += pointsFor("superOverLoss");
        } else {
          winner.points += pointsFor("win"); loser.points += pointsFor("loss");
        }
      }

      // Net run rate inputs. Runs are as scored; the OVERS are the "effective"
      // ones - a side bowled out early is charged its full quota (see nrrBallsFor).
      const hs = rd.home || {}, as = rd.away || {};
      const hBalls = nrrBallsFor(m, "home", teams);
      const aBalls = nrrBallsFor(m, "away", teams);
      H.runsFor += num(hs.runs); H.runsAgainst += num(as.runs);
      A.runsFor += num(as.runs); A.runsAgainst += num(hs.runs);
      H.ballsFor += hBalls; H.ballsAgainst += aBalls;
      A.ballsFor += aBalls; A.ballsAgainst += hBalls;
      if (!hBalls || !aBalls) { H.nrrKnown = false; A.nrrKnown = false; }
    });

    const out = Array.from(rows.values()).map(r => {
      const forOvers = r.ballsFor / 6, againstOvers = r.ballsAgainst / 6;
      const nrr = (r.nrrKnown && forOvers > 0 && againstOvers > 0)
        ? round2(r.runsFor / forOvers - r.runsAgainst / againstOvers)
        : null;
      return { ...r, nrr };
    });

    // Points, then NRR, then wins, then name. Teams with no NRR sort last on it.
    out.sort((a, b) =>
      b.points - a.points ||
      (b.nrr == null ? -Infinity : b.nrr) - (a.nrr == null ? -Infinity : a.nrr) ||
      b.wins - a.wins ||
      a.name.localeCompare(b.name));
    out.forEach((r, i) => { r.pos = i + 1; });
    return out;
  }

  root.HCCLFixtures = {
    CONFIG, STATUSES, STATUS_LABEL, FORMATS, RESULT_TYPES, TEST_RESULT_TYPES,
    isDecisiveResult, isFinalResult,
    STAGES, DEFAULT_STAGE, stageOf, stageMeta, countsForStandings, isKnockout,
    isTestMatch, inningsOf, bonusFor, battingBonusFor, bowlingBonusFor,
    inningsProgress, targetOf, testStandings,
    superOverOf, hasSuperOver, effectiveWinnerId,
    oversFromFormat, quotaBallsOf, battedFirstSide, nrrBallsFor,
    deriveResult, summarize, standings, findTeam, oversToBalls, ballsToOvers,
  };
})();
