/* ============================================================
   HCCL Fantasy - scoring & rules engine
   Pure logic: no DOM, no Firebase, no globals beyond the one export.
   Engine/view split, so the maths can be
   exercised from Node without a browser.

   Two vocabularies meet in here and it's worth being precise about them:

     MATCH      a document in the fantasy "days" collection. One fixture that
                contestants pick a team for. A match with no `lockAt` is a
                LEGACY match - created by the old moderator-only flow, where the
                teams were an array inside the match document itself.
     ENTRY      one contestant's fantasy team for one match. Modern entries are
                their own documents under fantasyEntries/**; legacy entries are
                the inline objects in match.entries[].

   Scoring: a player scores runs + wickets*10, the captain doubles, the
   vice-captain gets 1.5x. A PLAYOFF match adds one more call - predict the
   winning team - worth a flat PLAYOFF_BONUS on top of the entry's squad total.
   ============================================================ */
(function () {
  "use strict";

  /* ---------------- scoring ---------------- */

  function playerDayPoints(day, playerId) {
    const perf = day && day.performance && day.performance[playerId];
    if (!perf) return 0;
    return (Number(perf.runs) || 0) + (Number(perf.wickets) || 0) * 10;
  }

  /* ---------------- playoff winner bonus ----------------
     A PLAYOFF match asks for one extra call: which team wins. Get it right and
     a flat bonus lands on that match's entry total, so it flows into the day
     standings and the season leaderboard exactly like squad points do.

     It belongs to the ENTRY, not to any player - the same reasoning that keeps
     captaincy multipliers out of the Player of the Season board. A player's
     own season total is unaffected by what anyone predicted about his team. */
  const PLAYOFF_BONUS = 50;

  const isPlayoff = day => !!(day && day.isPlayoff);

  /* 0 unless this is a playoff match, the result has been recorded, and the
     entry called it. An unrecorded result (or a no-result/tie, which the editor
     stores as an empty winnerTeamId) pays nobody. */
  function winnerBonus(day, entry) {
    if (!isPlayoff(day)) return 0;
    const actual = (day && day.winnerTeamId) || "";
    if (!actual) return 0;
    return (entry && entry.winnerPick === actual) ? PLAYOFF_BONUS : 0;
  }

  /* `entry` needs only { playerIds, captainId, viceCaptainId, winnerPick }, which
     both the modern entry document and the legacy inline object satisfy. */
  function entryPoints(day, entry) {
    if (!entry || !Array.isArray(entry.playerIds)) return 0;
    const squad = entry.playerIds.reduce((sum, pid) => {
      let pts = playerDayPoints(day, pid);
      if (pid === entry.captainId) pts *= 2;
      else if (pid === entry.viceCaptainId) pts *= 1.5;
      return sum + pts;
    }, 0);
    return squad + winnerBonus(day, entry);
  }

  /* What a single player contributed to one entry, multiplier included. */
  function playerEntryPoints(day, entry, playerId) {
    let pts = playerDayPoints(day, playerId);
    if (!entry) return pts;
    if (playerId === entry.captainId) pts *= 2;
    else if (playerId === entry.viceCaptainId) pts *= 1.5;
    return pts;
  }

  /* ---------------- lock state ---------------- */

  const LEGACY = "legacy", OPEN = "open", LOCKED = "locked", PUBLISHED = "published";

  function lockState(day, now) {
    if (!day) return LOCKED;
    if (!day.lockAt) return LEGACY;          // pre-self-service match
    if (day.hasResults) return PUBLISHED;
    return (now || Date.now()) >= day.lockAt ? LOCKED : OPEN;
  }
  /* Can an entry be written right now? Mirrors matchOpen() in firestore.rules -
     the server is the authority, this is only so the UI agrees with it. */
  function isOpen(day, now) { return lockState(day, now) === OPEN; }

  function fmtCountdown(ms) {
    if (!(ms > 0)) return "closed";
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (d) return d + "d " + h + "h";
    if (h) return h + "h " + m + "m";
    if (m) return m + "m " + sec + "s";
    return sec + "s";
  }

  /* ---------------- squad validation ----------------
     `ctx` supplies the two lookups the engine deliberately doesn't own:
       teamOf(playerId)  -> teamId  (or "" when the player no longer exists)
       teamName(teamId)  -> display name, for the message text
     Both the live builder and the save-time check call these, so what the user
     is told and what is enforced can never drift apart. */

  function countByTeam(playerIds, ctx) {
    const counts = Object.create(null);
    (playerIds || []).forEach(pid => {
      const t = (ctx && ctx.teamOf && ctx.teamOf(pid)) || "";
      counts[t] = (counts[t] || 0) + 1;
    });
    return counts;
  }

  /* May this player be added to the draft as it currently stands?
     Used to dim tiles, so it must answer for players NOT yet picked. */
  function canPick(day, draft, playerId, ctx) {
    const ids = (draft && draft.playerIds) || [];
    if (ids.indexOf(playerId) >= 0) return { ok: true };   // already in - always removable
    const size = Number(day && day.teamSize) || 0;
    if (size && ids.length >= size) return { ok: false, msg: "Your team is full" };
    const cap = Number(day && day.maxPerTeam) || 0;
    if (cap) {
      const tid = (ctx && ctx.teamOf && ctx.teamOf(playerId)) || "";
      const have = countByTeam(ids, ctx)[tid] || 0;
      if (have >= cap) {
        const name = (ctx && ctx.teamName && ctx.teamName(tid)) || "one team";
        return { ok: false, msg: "Max " + cap + " from " + name };
      }
    }
    return { ok: true };
  }

  /* Is the draft submittable? Returns the single most useful next step, so the
     save bar always tells the user exactly one thing to do. */
  function validateEntry(day, draft, ctx) {
    const size = Number(day && day.teamSize) || 0;
    const ids = (draft && draft.playerIds) || [];

    if (new Set(ids).size !== ids.length) return { ok: false, msg: "The same player is picked twice" };
    if (size && ids.length < size) {
      const left = size - ids.length;
      return { ok: false, msg: "Pick " + left + " more player" + (left === 1 ? "" : "s") };
    }
    if (size && ids.length > size) return { ok: false, msg: "Too many players - pick " + size };
    if (!ids.length) return { ok: false, msg: "Pick your team" };

    const cap = Number(day && day.maxPerTeam) || 0;
    if (cap) {
      const counts = countByTeam(ids, ctx);
      for (const tid of Object.keys(counts)) {
        if (counts[tid] > cap) {
          const name = (ctx && ctx.teamName && ctx.teamName(tid)) || "one team";
          return { ok: false, msg: "Max " + cap + " from " + name + " - you have " + counts[tid] };
        }
      }
    }

    if (!draft || !draft.captainId) return { ok: false, msg: "Choose your captain" };
    if (!draft.viceCaptainId) return { ok: false, msg: "Choose your vice-captain" };
    if (draft.captainId === draft.viceCaptainId) return { ok: false, msg: "Captain and vice-captain must be different" };
    if (ids.indexOf(draft.captainId) < 0 || ids.indexOf(draft.viceCaptainId) < 0)
      return { ok: false, msg: "Captain and vice-captain must be in your team" };

    // Last, so the save bar walks the squad first and only then asks for the call.
    if (isPlayoff(day)) {
      const teams = (day && day.teamIds) || [];
      if (!draft.winnerPick) return { ok: false, msg: "Pick who wins this match" };
      if (teams.length && teams.indexOf(draft.winnerPick) < 0)
        return { ok: false, msg: "Pick one of the two teams to win" };
    }

    return { ok: true, msg: "" };
  }

  /* ---------------- standings ----------------
     A standings row is { k, n, p, pts } - key, name, photo, points. Short field
     names because this array is denormalised onto the match document, which
     every client downloads on every change.

     `k` must be stable ACROSS matches or the season table splits one person into
     several rows. It is the entry's document id: a Firebase uid for a
     self-submitted team, or "g_<name-slug>" for a moderator's guest entry (see
     guestId below). Legacy inline entries key off their contestant instead. */

  function guestId(name) {
    const slug = String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40);
    // Deliberately deterministic: the same guest keeps the same id every match,
    // so they aggregate into one leaderboard row, and re-adding them edits the
    // existing team instead of creating a duplicate.
    return slug ? "g_" + slug : "";
  }

  function sortRows(rows) {
    return rows.sort((a, b) => (b.pts - a.pts) || String(a.n || "").localeCompare(String(b.n || "")));
  }

  /* Modern entries -> standings rows. */
  function standingsFor(day, entries) {
    return sortRows((entries || []).map(e => ({
      k: e.id, n: e.name || "", p: e.photo || "", pts: entryPoints(day, e),
    })));
  }

  /* Legacy inline entries -> the same shape. `contestantName` resolves a
     contestant id to a display name. */
  function legacyStandings(day, contestantName) {
    const entries = (day && day.entries) || [];
    return sortRows(entries.map(e => ({
      k: "c:" + e.contestantId,
      n: (contestantName && contestantName(e.contestantId)) || "Unknown",
      p: "", pts: entryPoints(day, e),
    })));
  }

  /* What the leaderboard should count for one match, in priority order:
     the published standings, else live modern entries, else legacy inline ones.
     Published standings win because they are the record of who was in at the
     moment the editor pressed publish. */
  function rowsForDay(day, entries, contestantName) {
    if (day && Array.isArray(day.standings) && day.standings.length) return day.standings;
    if (entries && entries.length) return standingsFor(day, entries);
    return legacyStandings(day, contestantName);
  }

  /* ---------------- season leaderboard ----------------
     Aggregates published matches only. Legacy matches keep counting, so an old
     season's board is unchanged by the move to self-service. */
  function seasonRows(days, contestantName) {
    const map = new Map();
    (days || []).forEach(day => {
      if (!day || !day.hasResults) return;
      rowsForDay(day, null, contestantName).forEach(r => {
        if (!r || !r.k) return;
        const cur = map.get(r.k) || { key: r.k, name: r.n || "", photo: r.p || "", total: 0, days: 0 };
        cur.total += Number(r.pts) || 0;
        cur.days += 1;
        // Later matches win the name/photo: people rename themselves, and the
        // most recent is the one others will recognise.
        if (r.n) cur.name = r.n;
        if (r.p) cur.photo = r.p;
        map.set(r.k, cur);
      });
    });
    return [...map.values()]
      .map(r => Object.assign(r, { avg: r.days ? r.total / r.days : 0 }))
      .sort((a, b) => (b.total - a.total) || (b.avg - a.avg));
  }

  /* Season totals per PLAYER (the "Fantasy Player of the Season" board).
     Raw performance - captaincy multipliers are a property of an entry, not of
     the player, so they deliberately don't apply here. */
  function playerSeasonRows(days, players) {
    return (players || []).map(p => {
      let total = 0, n = 0;
      (days || []).forEach(d => {
        if (!d.hasResults) return;
        // Did he play THIS match? Scoring a match writes a performance entry for
        // every player in the pool (0/0 included), so `performance` is a
        // snapshot of who actually turned out, taken at the time. Asking instead
        // whether his CURRENT team is in this match silently erased the whole
        // history of anyone later transferred, of a team deleted and re-created,
        // and of any match whose teams were re-picked after it was scored - the
        // Contestants board kept those points, so the two boards disagreed.
        // The team check stays as a fallback for matches published before a
        // performance record existed; it can only add matches back, never drop one.
        const played = d.performance && Object.prototype.hasOwnProperty.call(d.performance, p.id);
        if (!played && !(d.teamIds || []).includes(p.teamId)) return;
        total += playerDayPoints(d, p.id); n++;
      });
      return { player: p, total, days: n, avg: n ? total / n : 0 };
    }).sort((a, b) => (b.total - a.total) || (b.avg - a.avg));
  }

  /* ============================================================
     WEEKLY + OVERALL modes
     A WEEK is a scoring period over the WHOLE tournament pool (every team,
     every player). Editors enter runs & wickets on it through the week, the
     same way they do for a daily match. One week sheet feeds two contests:
       - Weekly:  contestants pick a fresh team for that week only.
       - Overall: one season-long team, scored week by week.
     So a week is entered once and both leaderboards follow.

     OVERALL teams are versioned. history[0] is the pre-season team, stamped
     at:0 so it applies from the start; every post-lock change appends a
     version stamped with when it was made. A week is scored with the version
     in force when that week LOCKED, so a swap made mid-week counts from the
     next week - never retroactively for points already on the board.
     ============================================================ */
  const DEFAULT_TEAM_SIZE = 7;
  const DEFAULT_SWAPS = 3;

  /* How many players in `newIds` weren't in `oldIds` - i.e. swaps used. */
  function swapDiff(oldIds, newIds) {
    const before = new Set(oldIds || []);
    return (newIds || []).filter(id => !before.has(id)).length;
  }

  /* The version of an overall entry in force at time `ts`: the latest one
     stamped strictly BEFORE it. Scans everything rather than assuming order -
     the rules guarantee append-only, but scoring shouldn't depend on it. */
  function versionAt(entry, ts) {
    const h = entry && Array.isArray(entry.history) ? entry.history : [];
    if (!h.length) return entry;           // no history yet: the current team is all there is
    let best = null;
    h.forEach(v => {
      const at = Number(v && v.at) || 0;
      if (at < ts && (!best || at >= (Number(best.at) || 0))) best = v;
    });
    return best || h[0];
  }

  /* setup  - no lock time yet; nobody can enter
     open   - building / editing freely
     swaps  - locked; only swaps (and captaincy with them)
     closed - the editor ended the season; frozen */
  function seasonState(season, now) {
    if (!season || !(Number(season.lockAt) > 0)) return "setup";
    if (season.closed) return "closed";
    return (now || Date.now()) < season.lockAt ? "open" : "swaps";
  }

  const maxSwapsOf = season => (season && season.maxSwaps != null) ? Math.max(0, Number(season.maxSwaps) || 0) : DEFAULT_SWAPS;
  function swapsLeft(season, entry) {
    return Math.max(0, maxSwapsOf(season) - (Number(entry && entry.swapsUsed) || 0));
  }

  /* Can this post-lock change be submitted? -> { ok, msg, swaps }.
     Squad shape first (same rules as any team), then the swap budget. Unless
     the editor turned on freeCaptaincy, captain/vice-captain may only change
     in a submission that also swaps a player: post-lock, the swap IS the edit. */
  function validateSwap(season, entry, draft, ctx) {
    const base = validateEntry(season, draft, ctx);
    const swaps = swapDiff(entry && entry.playerIds, draft && draft.playerIds);
    if (!base.ok) return { ok: false, msg: base.msg, swaps };
    const left = swapsLeft(season, entry);
    const capChanged = !!entry && (draft.captainId !== entry.captainId || draft.viceCaptainId !== entry.viceCaptainId);
    if (left <= 0) return { ok: false, msg: "No swaps left - your team is final", swaps };
    if (!swaps && !capChanged) return { ok: false, msg: "Swap at least one player", swaps: 0 };
    if (!swaps && !(season && season.freeCaptaincy))
      return { ok: false, msg: "Captaincy can only change when you swap a player", swaps: 0 };
    if (swaps > left) return { ok: false, msg: "That's " + swaps + " swaps - you have " + left + " left", swaps };
    return { ok: true, msg: "", swaps };
  }

  /* Weeks that locked before the season did are left out of Overall: until
     the season locks, teams can still be rebuilt with that week's scores in
     full view. */
  function countsForOverall(season, week) {
    const L = Number(season && season.lockAt) || 0;
    return L > 0 && (Number(week && week.lockAt) || 0) >= L;
  }

  /* One week's Overall points per entry, with the version in force when the
     week locked. Same row shape as standingsFor, so it aggregates the same way. */
  function overallStandingsFor(season, week, entries) {
    if (!countsForOverall(season, week)) return [];
    return sortRows((entries || []).map(e => ({
      k: e.id, n: e.name || "", p: e.photo || "",
      pts: entryPoints(week, versionAt(e, Number(week.lockAt) || 0)),
    })));
  }

  /* Season tables from published weeks. `field` picks which denormalised
     standings to sum: "standings" (Weekly) or "overallStandings" (Overall). */
  function weekSeasonRows(weeks, field) {
    const map = new Map();
    (weeks || []).forEach(w => {
      if (!w || !w.hasResults || !Array.isArray(w[field])) return;
      w[field].forEach(r => {
        if (!r || !r.k) return;
        const cur = map.get(r.k) || { key: r.k, name: r.n || "", photo: r.p || "", total: 0, days: 0 };
        cur.total += Number(r.pts) || 0;
        cur.days += 1;
        if (r.n) cur.name = r.n;
        if (r.p) cur.photo = r.p;
        map.set(r.k, cur);
      });
    });
    return [...map.values()]
      .map(r => Object.assign(r, { avg: r.days ? r.total / r.days : 0 }))
      .sort((a, b) => (b.total - a.total) || (b.avg - a.avg));
  }

  /* One entry's Overall points week by week - for "my season" breakdowns.
     Only weeks that have LOCKED (a future week has nothing to score yet); a
     locked-but-unpublished week is computed live from the sheet as it stands. */
  function overallBreakdown(season, weeks, entry, now) {
    const t = now || Date.now();
    return (weeks || [])
      .filter(w => countsForOverall(season, w) && (Number(w.lockAt) || 0) <= t)
      .sort((a, b) => (Number(a.lockAt) || 0) - (Number(b.lockAt) || 0))
      .map(w => ({
        id: w.id, label: w.label || "", lockAt: Number(w.lockAt) || 0, published: !!w.hasResults,
        pts: entryPoints(w, versionAt(entry, Number(w.lockAt) || 0)),
      }));
  }

  const api = {
    LEGACY, OPEN, LOCKED, PUBLISHED, PLAYOFF_BONUS,
    playerDayPoints, entryPoints, playerEntryPoints, isPlayoff, winnerBonus,
    lockState, isOpen, fmtCountdown,
    countByTeam, canPick, validateEntry,
    guestId, standingsFor, legacyStandings, rowsForDay, seasonRows, playerSeasonRows,
    // weekly + overall
    DEFAULT_TEAM_SIZE, DEFAULT_SWAPS,
    swapDiff, versionAt, seasonState, swapsLeft, validateSwap,
    countsForOverall, overallStandingsFor, weekSeasonRows, overallBreakdown,
  };

  if (typeof window !== "undefined") window.HCCLFantasyEngine = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
