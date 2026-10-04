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

   Scoring is unchanged from the original implementation: a player scores
   runs + wickets*10, the captain doubles, the vice-captain gets 1.5x.
   ============================================================ */
(function () {
  "use strict";

  /* ---------------- scoring ---------------- */

  function playerDayPoints(day, playerId) {
    const perf = day && day.performance && day.performance[playerId];
    if (!perf) return 0;
    return (Number(perf.runs) || 0) + (Number(perf.wickets) || 0) * 10;
  }

  /* `entry` needs only { playerIds, captainId, viceCaptainId }, which both the
     modern entry document and the legacy inline object satisfy. */
  function entryPoints(day, entry) {
    if (!entry || !Array.isArray(entry.playerIds)) return 0;
    return entry.playerIds.reduce((sum, pid) => {
      let pts = playerDayPoints(day, pid);
      if (pid === entry.captainId) pts *= 2;
      else if (pid === entry.viceCaptainId) pts *= 1.5;
      return sum + pts;
    }, 0);
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

  const api = {
    LEGACY, OPEN, LOCKED, PUBLISHED,
    playerDayPoints, entryPoints, playerEntryPoints,
    lockState, isOpen, fmtCountdown,
    countByTeam, canPick, validateEntry,
    guestId, standingsFor, legacyStandings, rowsForDay, seasonRows, playerSeasonRows,
  };

  if (typeof window !== "undefined") window.HCCLFantasyEngine = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
