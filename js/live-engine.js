/* ============================================================
   HC LIVE - hand-cricket scoring engine  (window.HCCLLiveEngine)

   PURE: no DOM, no Firestore, nothing global touched. Everything
   on screen is DERIVED by folding an ordered event list, so the
   database only ever stores the match settings + the events -
   never a score. That makes Undo exact (drop the last event and
   recompute) and guarantees every device agrees.

   The hand-cricket rules encoded here:
     - Only 0 1 2 3 4 5 6 and W (bowled). No extras, so every ball
       is legal and an over is ALWAYS 6 balls.
     - Strike NEVER rotates - odd runs do not swap, the end of an
       over does not swap. One batsman is at the crease until he is
       bowled, so there is no non-striker and no partnership.
     - Every wicket is credited to the bowler of that over.
     - The scorer picks the incoming batsman after each wicket and
       a bowler at the start of every over.
     - An innings closes on: overs exhausted, wickets limit hit, no
       batsman left, the target passed, or the scorer ending it.

   Closure is checked PER EVENT, not after the whole fold - so a
   double-tap or a stale client can never push the score past the
   end of an innings.
   ============================================================ */
(function () {
  "use strict";

  const DIGITS = [0, 1, 2, 3, 4, 5, 6];
  const SIDES = ["A", "B"];

  const CLOSE_LABEL = {
    overs:     "Overs completed",
    wickets:   "All out",
    noBatsmen: "No batsmen left",
    target:    "Target reached",
    manual:    "Innings closed by the scorer",
  };

  /* ------------------------------ helpers ------------------------------ */
  const int = (v, d) => { const n = Math.floor(Number(v)); return isFinite(n) && n > 0 ? n : d; };
  const other = side => (side === "A" ? "B" : "A");

  /** 10 balls -> "1.4". Cricket over notation, not a decimal. */
  function ballsToOvers(balls) {
    balls = Math.max(0, Math.floor(balls) || 0);
    return Math.floor(balls / 6) + "." + (balls % 6);
  }
  /** Runs per over. Guards the 0-ball case that would otherwise be NaN. */
  function runRate(runs, balls) { return balls > 0 ? (runs * 6) / balls : 0; }
  /** Batting strike rate: runs per 100 balls. */
  function strikeRate(runs, balls) { return balls > 0 ? (runs * 100) / balls : 0; }
  /** Bowling economy: runs per over. */
  function economy(runs, balls) { return balls > 0 ? (runs * 6) / balls : 0; }
  const fmt2 = n => (Math.round(n * 100) / 100).toFixed(2);

  function squadOf(match, side) {
    const t = (match && match.teams && match.teams[side]) || {};
    return Array.isArray(t.players) ? t.players : [];
  }
  function teamName(match, side) {
    const t = (match && match.teams && match.teams[side]) || {};
    return t.name || (side === "A" ? "Team A" : "Team B");
  }
  function playerName(match, side, id) {
    const p = squadOf(match, side).find(x => x.id === id);
    return p ? p.name : "";
  }

  /* --------------------------- innings record --------------------------- */
  function newInnings(index, batSide, bowlSide) {
    return {
      index, batSide, bowlSide,
      runs: 0, wickets: 0, balls: 0,
      target: null,        // innings 2 only: the score that WINS it
      batsmen: [],         // { id, runs, balls, fours, sixes, out, outBy, order }
      bowlers: [],         // { id, balls, runs, wickets, maidens }
      overs: [],           // [{ n, bowlerId, balls: [0..6 | "W"] }]
      fow: [],             // [{ wicket, runs, balls, batId, bowlerId }]
      timeline: [],        // [{ over, ball, v, batId, bowlerId, runs, wickets }]
      strikerId: null,     // null => the scorer must pick the next batsman
      bowlerId: null,      // null => the scorer must pick this over's bowler
      started: false,
      closed: false, closeReason: "",
    };
  }

  const findBat  = (inn, id) => inn.batsmen.find(b => b.id === id) || null;
  const findBowl = (inn, id) => inn.bowlers.find(b => b.id === id) || null;

  function ensureBat(inn, id) {
    let b = findBat(inn, id);
    if (!b) {
      b = { id, runs: 0, balls: 0, fours: 0, sixes: 0, out: false, outBy: null, order: inn.batsmen.length };
      inn.batsmen.push(b);
    }
    return b;
  }
  function ensureBowl(inn, id) {
    let b = findBowl(inn, id);
    if (!b) { b = { id, balls: 0, runs: 0, wickets: 0, maidens: 0 }; inn.bowlers.push(b); }
    return b;
  }

  /** The over this delivery lands in, created on demand and tagged with its bowler. */
  function currentOver(inn) {
    const n = Math.floor(inn.balls / 6);
    let o = inn.overs[n];
    if (!o) { o = { n, bowlerId: inn.bowlerId, balls: [] }; inn.overs[n] = o; }
    return o;
  }

  /* ------------------------------ the fold ------------------------------ */
  /* Applies ONE delivery (a digit or a wicket), then re-tests closure.
     Everything that ends an innings is checked here, immediately, so the
     engine - not the UI - is the authority on when an innings is over. */
  function applyDelivery(inn, ev, limits) {
    // A delivery with nobody at the crease (or no bowler) is a malformed event
    // list. Ignoring it keeps the fold total rather than throwing halfway
    // through a match people are watching.
    if (!inn.strikerId || !inn.bowlerId) return;

    const bat  = ensureBat(inn, inn.strikerId);
    const bowl = ensureBowl(inn, inn.bowlerId);
    const over = currentOver(inn);
    const isWicket = ev.t === "wicket";
    const v = isWicket ? 0 : Math.max(0, Math.min(6, Math.floor(Number(ev.v) || 0)));

    bat.balls++; bowl.balls++; inn.balls++;

    if (isWicket) {
      bat.out = true; bat.outBy = inn.bowlerId;
      bowl.wickets++;
      inn.wickets++;
      inn.fow.push({ wicket: inn.wickets, runs: inn.runs, balls: inn.balls, batId: bat.id, bowlerId: bowl.id });
      inn.strikerId = null;                      // the scorer picks the next man in
    } else {
      inn.runs += v; bat.runs += v; bowl.runs += v;
      if (v === 4) bat.fours++;
      if (v === 6) bat.sixes++;
    }

    over.balls.push(isWicket ? "W" : v);
    inn.timeline.push({
      over: over.n, ball: over.balls.length, v: isWicket ? "W" : v,
      batId: bat.id, bowlerId: bowl.id, runs: inn.runs, wickets: inn.wickets,
    });

    // End of the over: credit a maiden, then clear the bowler so the scorer is
    // asked for the next one.
    if (inn.balls % 6 === 0) {
      if (over.balls.length === 6 && over.balls.every(b => b === 0 || b === "W")) bowl.maidens++;
      inn.bowlerId = null;
    }

    /* ---- closure, in priority order ---- */
    if (inn.target != null && inn.runs >= inn.target) { close(inn, "target"); return; }
    if (inn.wickets >= limits.wicketsLimit) { close(inn, "wickets"); return; }
    if (inn.balls >= limits.overs * 6) { close(inn, "overs"); return; }
    // Out of bodies: the whole squad has batted and the last one is gone. Only
    // reachable when the wickets limit is set higher than the squad size.
    if (!inn.strikerId && limits.squadSize > 0
        && inn.batsmen.length >= limits.squadSize
        && inn.batsmen.every(b => b.out)) close(inn, "noBatsmen");
  }

  function close(inn, reason) {
    inn.closed = true; inn.closeReason = reason;
    inn.strikerId = null; inn.bowlerId = null;
  }

  /* --------------------------- public: compute --------------------------- */
  /** Fold a match document into everything the screen needs. */
  function compute(match) {
    match = match || {};
    const overs = int(match.overs, 5);
    const wicketsLimit = int(match.wicketsLimit, 5);
    const battingFirst = match.battingFirst === "B" ? "B" : "A";

    const innings = [
      newInnings(0, battingFirst, other(battingFirst)),
      newInnings(1, other(battingFirst), battingFirst),
    ];

    const events = Array.isArray(match.events) ? match.events : [];
    let cur = 0;

    for (let i = 0; i < events.length; i++) {
      const ev = events[i] || {};
      const inn = innings[cur];
      if (!inn || inn.closed) continue;   // past the end of the match: ignore

      const limits = { overs, wicketsLimit, squadSize: squadOf(match, inn.batSide).length };

      if (ev.t === "bat") {
        if (!inn.strikerId && ev.p) { inn.strikerId = ev.p; ensureBat(inn, ev.p); inn.started = true; }
      } else if (ev.t === "bowl") {
        if (!inn.bowlerId && ev.p) { inn.bowlerId = ev.p; ensureBowl(inn, ev.p); }
      } else if (ev.t === "ball" || ev.t === "wicket") {
        applyDelivery(inn, ev, limits);
      } else if (ev.t === "endInnings") {
        close(inn, "manual");
      }

      if (inn.closed) {
        // Hand the chase its target the moment the first innings ends.
        if (cur === 0) innings[1].target = inn.runs + 1;
        cur++;
      }
    }

    // A match sitting at the innings break still needs the target on screen.
    if (innings[0].closed && innings[1].target == null) innings[1].target = innings[0].runs + 1;

    const liveIndex = innings[0].closed ? (innings[1].closed ? -1 : 1) : 0;
    const live = liveIndex >= 0 ? innings[liveIndex] : null;

    let phase;
    if (liveIndex < 0) phase = "complete";
    else if (liveIndex === 1 && !innings[1].started) phase = "break";
    else if (liveIndex === 0 && !innings[0].started) phase = "notStarted";
    else phase = "inProgress";

    return {
      match, overs, wicketsLimit, battingFirst,
      innings, liveIndex, live, phase,
      need: need(live),
      result: phase === "complete" ? buildResult(match, innings, wicketsLimit) : null,
    };
  }

  /** What the scoring panel must ask for next. */
  function need(inn) {
    if (!inn) return "none";
    if (!inn.strikerId) return "bat";
    if (!inn.bowlerId) return "bowl";
    return "ball";
  }

  function buildResult(match, innings, wicketsLimit) {
    const i1 = innings[0], i2 = innings[1];
    const target = i2.target != null ? i2.target : i1.runs + 1;
    const chaseName = teamName(match, i2.batSide);
    const setName = teamName(match, i1.batSide);

    if (i2.runs >= target) {
      const by = Math.max(0, wicketsLimit - i2.wickets);
      return {
        type: "win", winner: i2.batSide, margin: by, marginUnit: "wickets",
        summary: chaseName + " won by " + by + " wicket" + (by === 1 ? "" : "s"),
      };
    }
    if (i2.runs === target - 1) {
      return { type: "tie", winner: null, margin: 0, marginUnit: "", summary: "Match tied" };
    }
    const by = (target - 1) - i2.runs;
    return {
      type: "win", winner: i1.batSide, margin: by, marginUnit: "runs",
      summary: setName + " won by " + by + " run" + (by === 1 ? "" : "s"),
    };
  }

  /* --------------------------- pickable players --------------------------- */
  /** Batsmen who have not been in yet - everyone bats once. */
  function availableBatsmen(state) {
    const inn = state.live;
    if (!inn) return [];
    const used = new Set(inn.batsmen.map(b => b.id));
    return squadOf(state.match, inn.batSide).filter(p => !used.has(p.id));
  }
  /** Any member of the bowling side may bowl any over. */
  function availableBowlers(state) {
    const inn = state.live;
    if (!inn) return [];
    return squadOf(state.match, inn.bowlSide);
  }

  /* ------------------------------ chase maths ----------------------------- */
  function chaseInfo(state) {
    const inn = state.live;
    if (!inn || inn.index !== 1 || inn.target == null) return null;
    const need = Math.max(0, inn.target - inn.runs);
    const ballsLeft = Math.max(0, state.overs * 6 - inn.balls);
    return {
      target: inn.target, need, ballsLeft,
      wicketsLeft: Math.max(0, state.wicketsLimit - inn.wickets),
      rrr: ballsLeft > 0 ? (need * 6) / ballsLeft : 0,
    };
  }

  /* ------------------------------ validation ------------------------------ */
  /** Whether a match document is complete enough to score. */
  function validate(match) {
    const errs = [];
    SIDES.forEach(s => {
      // The RAW stored name, not teamName() - that falls back to "Team A" for
      // display, which would quietly pass a match nobody had named.
      const raw = ((match && match.teams && match.teams[s]) || {}).name;
      if (!String(raw == null ? "" : raw).trim()) errs.push("Team " + s + " needs a name");
      if (squadOf(match, s).length < 1) errs.push(teamName(match, s) + " needs at least one player");
    });
    if (int(match && match.overs, 0) < 1) errs.push("Overs must be at least 1");
    if (int(match && match.wicketsLimit, 0) < 1) errs.push("Wickets must be at least 1");
    return errs;
  }

  window.HCCLLiveEngine = {
    DIGITS, SIDES, CLOSE_LABEL,
    compute, validate,
    availableBatsmen, availableBowlers, chaseInfo,
    ballsToOvers, runRate, strikeRate, economy, fmt2,
    squadOf, teamName, playerName, other,
  };
})();
