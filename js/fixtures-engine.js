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
       match splits a point, as in most cricket leagues. Adjust these numbers
       (or add a key + handle it in pointsFor) if the format changes. */
    points: { win: 2, tie: 1, loss: 0, abandoned: 1 },

    // Abandoned matches still count as "played" in the table (they carry points).
    countAbandonedAsPlayed: true,

    // A team is all out one wicket short of its batting strength. Used to work
    // out "won by N wickets"; falls back to this when the squad size is unknown.
    defaultWicketsPerSide: 10,
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
  const RESULT_TYPES = ["runs", "wickets", "tie", "abandoned", "no-result"];

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

    let resultType = "no-result", winnerName = "", margin = 0;
    if (first && second) {
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

    return {
      resultType,
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

  // "Zyco Kings won by 14 runs" / "… by 3 wickets" / "Match tied" / "Abandoned".
  function summarize(rd) {
    if (!rd) return "";
    const w = rd.winnerName || "";
    switch (rd.resultType) {
      case "runs": return w ? `${w} won by ${rd.margin} run${rd.margin === 1 ? "" : "s"}` : "";
      case "wickets": return w ? `${w} won by ${rd.margin} wicket${rd.margin === 1 ? "" : "s"}` : "";
      case "tie": return "Match tied";
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
          : p.loss;
  }

  // matches: our stored match docs. teams: our team records.
  // Only COMPLETED, GROUP-STAGE matches with resultData count. Playoff results
  // (Qualifier / Eliminator / Final) are excluded entirely - no points AND no
  // runs, so they can't skew net run rate either.
  function standings(matches, teams) {
    const rows = new Map();
    const seed = t => {
      if (!rows.has(t.id)) rows.set(t.id, {
        teamId: t.id, name: t.name, logo: t.logo || "",
        played: 0, wins: 0, losses: 0, ties: 0, noResults: 0, points: 0,
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
      if (rd.resultType === "tie") {
        H.ties++; A.ties++;
        H.points += pointsFor("tie"); A.points += pointsFor("tie");
      } else {
        const homeWon = rd.winnerTeamId ? rd.winnerTeamId === home.id : false;
        const winner = homeWon ? H : A, loser = homeWon ? A : H;
        winner.wins++; loser.losses++;
        winner.points += pointsFor("win"); loser.points += pointsFor("loss");
      }

      // Net run rate inputs.
      const hs = rd.home || {}, as = rd.away || {};
      H.runsFor += num(hs.runs); H.runsAgainst += num(as.runs);
      A.runsFor += num(as.runs); A.runsAgainst += num(hs.runs);
      H.ballsFor += num(hs.balls); H.ballsAgainst += num(as.balls);
      A.ballsFor += num(as.balls); A.ballsAgainst += num(hs.balls);
      if (!num(hs.balls) || !num(as.balls)) { H.nrrKnown = false; A.nrrKnown = false; }
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
    CONFIG, STATUSES, STATUS_LABEL, FORMATS, RESULT_TYPES,
    STAGES, DEFAULT_STAGE, stageOf, stageMeta, countsForStandings, isKnockout,
    deriveResult, summarize, standings, findTeam, oversToBalls, ballsToOvers,
  };
})();
