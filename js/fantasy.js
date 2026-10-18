/* ============================================================
   HCCL Fantasy League  (self-contained - does not touch the auction)

   Every signed-in member picks their own team. An editor creates a MATCH
   (two teams, a squad size, an optional per-team cap and a closing time);
   until that closing time anyone may submit and re-edit their team; after it
   nobody may, editors included. Once the match is played, editors enter runs
   and wickets and publish the points.

   Where things live:
     fantasy/league/{teams|players|contestants|days}/{id}   the league + matches
     fantasyEntries/{tid}/days/{dayId}/entries/{entryId}    contestants' teams

   The entries deliberately sit outside the fantasy/ and tournaments/ roots -
   see the comment on entryColl() and firestore.rules.

   Scoring, lock state and squad validation live in js/fantasy-engine.js so
   they can be tested without a browser. Reads the live auction
   (window.HCCLAuction) only for the "Import from auction" button.
   ============================================================ */
(function () {
  "use strict";

  const FKEY = "hccl_fantasy_v1";
  const ENG = (typeof window !== "undefined" && window.HCCLFantasyEngine)
    || (typeof require !== "undefined" ? require("./fantasy-engine.js") : null);

  /* ---------------- state ---------------- */
  function defaultFantasy() {
    return { teams: [], players: [], contestants: [], days: [] };
  }
  function normalizeF(s) {
    s = s || {};
    s.teams = Array.isArray(s.teams) ? s.teams : [];
    s.players = Array.isArray(s.players) ? s.players : [];
    s.contestants = Array.isArray(s.contestants) ? s.contestants : [];
    s.days = (Array.isArray(s.days) ? s.days : []).map(normDay);
    return s;
  }
  /* The ONE place a match document's shape is defined. Both the Firestore
     reader (normItem) and the local/backup reader (normalizeF) go through it.
     See the invariant comment above syncDiff before adding a field. */
  function normDay(d) {
    d = d || {};
    return {
      id: d.id, date: d.date || "", label: d.label || "",
      teamIds: Array.isArray(d.teamIds) ? d.teamIds : [],
      performance: d.performance || {},
      // LEGACY inline entries (pre-self-service). Read-only: nothing writes to
      // this array any more, but it MUST survive the round-trip or syncDiff's
      // whole-doc set() would erase every old season's fantasy history.
      entries: (Array.isArray(d.entries) ? d.entries : []).map(e => ({
        id: e.id, contestantId: e.contestantId,
        playerIds: Array.isArray(e.playerIds) ? e.playerIds : [],
        captainId: e.captainId || null, viceCaptainId: e.viceCaptainId || null,
        winnerPick: e.winnerPick || "",
      })),
      hasResults: !!d.hasResults,
      // PLAYOFF match: contestants also call the winner, worth a flat bonus.
      // winnerTeamId is the result an editor records - "" means not decided yet
      // (or a no-result), and pays nobody.
      isPlayoff: !!d.isPlayoff,
      winnerTeamId: d.winnerTeamId || "",
      // Self-service fields. A day with no lockAt is a legacy day.
      teamSize: Number(d.teamSize) || 0,
      maxPerTeam: Number(d.maxPerTeam) || 0,
      lockAt: Number(d.lockAt) || 0,
      standings: Array.isArray(d.standings) ? d.standings : null,
      createdAt: Number(d.createdAt) || 0, createdBy: d.createdBy || "",
      publishedAt: Number(d.publishedAt) || 0, publishedBy: d.publishedBy || "",
    };
  }
  function normEntry(id, d) {
    d = d || {};
    return {
      id, uid: d.uid || "", name: d.name || "", photo: d.photo || "", teamName: d.teamName || "",
      playerIds: Array.isArray(d.playerIds) ? d.playerIds : [],
      captainId: d.captainId || "", viceCaptainId: d.viceCaptainId || "",
      winnerPick: d.winnerPick || "",   // playoff matches only
      createdAt: Number(d.createdAt) || 0,
      // serverTimestamp() resolves to a Timestamp on the server round-trip and
      // to null in the optimistic local snapshot before it.
      updatedAt: (d.updatedAt && d.updatedAt.toMillis) ? d.updatedAt.toMillis() : (Number(d.updatedAt) || 0),
    };
  }
  function loadF() {
    try { const r = localStorage.getItem(FKEY); if (r) return normalizeF(JSON.parse(r)); } catch (e) {}
    return defaultFantasy();
  }
  function saveF() {
    // In cloud mode Firestore is the source of truth; leave the local backup
    // (FKEY) untouched so a one-time "upload to cloud" can still recover it.
    if (usingFirestore) { if (canEditApp()) syncDiff(); return; }
    try { localStorage.setItem(FKEY, JSON.stringify(F)); } catch (e) { ftoast("Storage full - export a backup", "bad"); }
  }

  let F = loadF();
  const UI = {
    sub: "matches",        // matches | leaderboard | manage
    view: "list",          // list | build | teams | form | scores
    dayId: null,           // the match `view` is about
    draft: null,           // { playerIds, captainId, viceCaptainId, dirty }
    assign: null,          // "c" | "vc" while a captaincy slot is armed
    guest: false,          // editor is building a team for someone with no account
    editEntryId: null,     // which entry the editor is amending (null = my own)
    saving: false,
    form: null,            // the editor's match draft
    editTeamId: null, editPlayerId: null,
  };

  /* ============================================================
     FIRESTORE REAL-TIME SYNC (Phase C)
     When Firebase is configured, fantasy data lives in Firestore under
     fantasy/league/{teams,players,contestants,days}/{id}. onSnapshot mirrors
     it into F; local edits (saveF) are pushed as a minimal diff. With no
     Firebase (or if it can't be reached) we stay on localStorage as before.
     ============================================================ */
  const FS_COLLS = ["teams", "players", "contestants", "days"];
  let usingFirestore = false;
  let fsReady = false;                 // true once every collection has loaded at least once
  const fsLoaded = new Set();
  const fsMirror = { teams: [], players: [], contestants: [], days: [] }; // last known server state
  const fsUnsubs = [];
  let pendingRender = false;           // defer re-render while an editor is typing
  let fsSyncing = false, fsSyncAgain = false;
  let fsFellBack = false, fsFellBackMsg = "";  // cloud unreachable -> local-only
  let fsRetries = 0;  // consecutive transient failures (drives the backoff)
  let fsGen = 0;      // subscription generation (bumped on every (re)subscribe)
  let fanTid = null;  // tournament id the current subscriptions belong to

  const fsDb = () => window.HCCL && window.HCCL.db;
  const fsApi = () => window.HCCL && window.HCCL.fs;
  // Tournament namespace (js/series.js): [] = legacy roots, else ["tournaments", tid].
  const fsPrefix = () => (window.HCCLSeries ? window.HCCLSeries.prefix() : []);
  function fsRef(coll, id) { return fsApi().doc(fsDb(), ...fsPrefix(), "fantasy", "league", coll, id); }

  /* Contestant entries live at fantasyEntries/{tid}/days/{dayId}/entries/{id},
     deliberately OUTSIDE fantasy/ and tournaments/. Those two roots are guarded
     by recursive {document=**} rules granting read to any signed-in user and
     write to any editor; because rules are OR-ed, nothing nested under them can
     be made stricter. This feature needs both "rivals' picks stay hidden until
     the deadline" and "the deadline binds moderators too", so the entries need a
     root of their own. See firestore.rules. */
  const LEGACY_TID = "hccl-s6";
  const entryTid = () => (window.HCCLSeries && window.HCCLSeries.viewingId()) || LEGACY_TID;
  function entryColl(dayId) { return fsApi().collection(fsDb(), "fantasyEntries", entryTid(), "days", dayId, "entries"); }
  function entryRef(dayId, entryId) { return fsApi().doc(fsDb(), "fantasyEntries", entryTid(), "days", dayId, "entries", entryId); }

  function stripId(o) { const c = Object.assign({}, o); delete c.id; return c; }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  function normItem(coll, id, d) {
    if (coll === "days") return normDay(Object.assign({}, d, { id }));
    if (coll === "players") return { id, name: d.name || "", teamId: d.teamId || "" };
    return { id, name: d.name || "" }; // teams, contestants
  }

  /* Terminal failure only (bad rules, no database). Never called for a merely
     slow or flaky connection - see fanRetryLater. */
  function fallbackToLocal(msg) {
    if (fsFellBack || fsReady) return;     // already loaded fine, or already fell back
    fsFellBack = true; fsFellBackMsg = msg;
    fsUnsubs.splice(0).forEach(u => { try { u(); } catch (e) {} });
    stopEntries();
    usingFirestore = false;
    // Only blank the board if nothing ever arrived - with the persistent cache
    // a snapshot usually HAS landed. The local backup only holds the LEGACY
    // tournament's fantasy data.
    if (!fsLoaded.size)
      F = (!window.HCCLSeries || window.HCCLSeries.isLegacy()) ? loadF() : defaultFantasy();
    ftoast(msg, "bad");
    renderFantasy();
  }

  /* Transient failure: onSnapshot's error callback is terminal, so the dead
     listeners are dropped and the whole set resubscribed with backoff. Cloud
     mode stays ON, so edits keep queueing through Firestore.
     Debounced - all four collections error together when the network drops, and
     un-guarded they'd each cancel the previous retry and inflate the backoff. */
  let fsRetryPending = false;
  function fanRetryLater() {
    if (fsFellBack || !usingFirestore || fsRetryPending) return;
    fsRetryPending = true;
    const gen = ++fsGen;
    fsUnsubs.splice(0).forEach(u => { try { u(); } catch (e) {} });
    stopEntries();
    const wait = window.HCCLSync ? window.HCCLSync.backoff(fsRetries++) : 4000;
    setTimeout(() => {
      fsRetryPending = false;
      if (gen === fsGen && !fsFellBack && usingFirestore) startFantasySync();
    }, wait);
  }

  function startFantasySync() {
    const api = fsApi(), db = fsDb();
    const gen = ++fsGen;
    FS_COLLS.forEach(coll => {
      const unsub = api.onSnapshot(api.collection(db, ...fsPrefix(), "fantasy", "league", coll),
        snap => {
          const items = snap.docs.map(docSnap => normItem(coll, docSnap.id, docSnap.data()));
          fsMirror[coll] = clone(items);
          F[coll] = items;
          fsLoaded.add(coll);
          fsRetries = 0;
          if (!fsReady && fsLoaded.size === FS_COLLS.length) fsReady = true;
          onRemoteChange();
        },
        err => {
          console.error("fantasy snapshot error:", coll, err);
          if (window.HCCLSync && !window.HCCLSync.isTerminal(err)) { fanRetryLater(); return; }
          const code = err && err.code;
          fallbackToLocal(
            code === "permission-denied" ? "Cloud blocked: publish the latest Firestore rules"
              : code === "not-found" ? "Firestore database not created yet - create it in the Firebase console"
              : "Live sync unavailable - this device only");
        }
      );
      fsUnsubs.push(unsub);
    });
  }

  /* Network or tab came back: try the cloud again rather than making the user
     reload. */
  function fanRetrySync() {
    const H = window.HCCL;
    if (!H || !H.configured || !H.user) return;
    if (!usingFirestore && !fsFellBack) { fanMaybeStartSync(); return; }
    if (fsReady) return;                 // already healthy
    fsGen++;
    fsUnsubs.splice(0).forEach(u => { try { u(); } catch (e) {} });
    stopEntries();
    fsFellBack = false; fsFellBackMsg = ""; fsRetries = 0;
    usingFirestore = true;
    startFantasySync();
  }

  /* Start syncing once BOTH auth (HCCL) and the tournament registry
     (HCCLSeries) are ready - the registry decides which paths to read. */
  function fanMaybeStartSync() {
    const H = window.HCCL, S = window.HCCLSeries;
    if (!H || !H.configured || !H.user || usingFirestore || fsFellBack || !fsDb() || !fsApi()) return;
    if (S && !S.ready) return;
    fanTid = S ? S.viewingId() : null;
    usingFirestore = true;
    startFantasySync();
  }

  /* Viewed tournament changed: drop the old listeners and resubscribe. */
  function fanOnSeriesChange(S) {
    if (!S.ready) return;
    const tid = S.viewingId();
    if (!usingFirestore) { fanMaybeStartSync(); return; }
    if (tid === fanTid) return;
    fanTid = tid;
    fsGen++; // disarm any pending retry from the old subscriptions
    fsUnsubs.splice(0).forEach(u => { try { u(); } catch (e) {} });
    stopEntries();
    myEntryCache.clear();
    fsReady = false; fsLoaded.clear(); fsFellBack = false; fsFellBackMsg = ""; fsRetries = 0;
    fsMirror.teams = []; fsMirror.players = []; fsMirror.contestants = []; fsMirror.days = [];
    F = defaultFantasy();
    resetUI();
    renderFantasy();
    startFantasySync();
  }
  function resetUI() {
    UI.view = "list"; UI.dayId = null; UI.draft = null; UI.assign = null;
    UI.guest = false; UI.editEntryId = null; UI.form = null;
    UI.editTeamId = null; UI.editPlayerId = null;
  }

  function onRemoteChange() {
    // Don't clobber a save that's mid-flight; the finally block re-renders.
    if (UI.saving) { pendingRender = true; return; }
    // Don't wipe an editor's in-progress typing; defer the re-render until blur.
    const ae = document.activeElement, root = fanEl();
    if (ae && root && root.contains(ae) && ["INPUT", "SELECT", "TEXTAREA"].includes(ae.tagName)) {
      pendingRender = true; return;
    }
    renderFantasy();
  }

  /* INVARIANT - read before adding a field to any fantasy document.
     The write below is batch.set(ref, stripId(item)): a FULL document replace
     built from the in-memory object, which normItem() reconstructed from a
     fixed field list. Any field normItem doesn't know about is therefore
     DELETED from Firestore the moment an editor touches that document. Add new
     day fields to normDay(), not just to whatever code writes them.

     Note also that a rules change adding a get() to the days collection would
     break this: rules_version 2 allows 20 access calls per batched write and
     these batches run to 450 ops. Per-document validation belongs on
     fantasyEntries/**, which is only ever written one document at a time. */
  async function syncDiff() {
    if (!fsReady) return;            // never push until we have the server baseline
    if (fsSyncing) { fsSyncAgain = true; return; }
    fsSyncing = true;
    try {
      const api = fsApi(), db = fsDb();
      const ops = [];
      FS_COLLS.forEach(coll => {
        const cur = F[coll] || [], prev = fsMirror[coll] || [];
        const prevMap = new Map(prev.map(x => [x.id, x]));
        const curIds = new Set(cur.map(x => x.id));
        cur.forEach(item => {
          const before = prevMap.get(item.id);
          if (!before || JSON.stringify(stripId(before)) !== JSON.stringify(stripId(item)))
            ops.push({ t: "set", ref: fsRef(coll, item.id), data: stripId(item) });
        });
        prev.forEach(item => { if (!curIds.has(item.id)) ops.push({ t: "del", ref: fsRef(coll, item.id) }); });
      });
      for (let i = 0; i < ops.length; i += 450) {        // Firestore batch limit is 500
        const batch = api.writeBatch(db);
        ops.slice(i, i + 450).forEach(op => op.t === "set" ? batch.set(op.ref, op.data) : batch.delete(op.ref));
        await batch.commit();
      }
      FS_COLLS.forEach(coll => { fsMirror[coll] = clone(F[coll] || []); }); // advance baseline
    } catch (e) {
      console.error("fantasy sync failed:", e);
      ftoast("Couldn't save to the cloud", "bad");
      FS_COLLS.forEach(coll => { F[coll] = clone(fsMirror[coll] || []); }); // revert to server state
      renderFantasy();
    } finally {
      fsSyncing = false;
      if (fsSyncAgain) { fsSyncAgain = false; syncDiff(); }
    }
  }

  /* ============================================================
     ENTRIES SYNC - one live listener, for the match on screen only.

     Which listener depends on what the rules will actually allow:
       editors, and everyone once a match has closed -> the whole collection
       everyone else, while a match is still open     -> just their own document
     There is no third option: firebase-init.js does not export `where`, so a
     "only my own row" collection query is not available to us even if the rules
     wanted one.
     ============================================================ */
  let entUnsub = null, entDayId = null, entTid = null, entGen = 0;
  let entries = [], entLoaded = false, entAll = false, entRetries = 0;
  // dayId -> my entry (or null). Lets the match LIST show "your team is in"
  // without a listener per match. Published matches never need an entry here:
  // their standings already carry every score.
  const myEntryCache = new Map();
  const myEntryFetching = new Set();

  const myUid = () => (window.HCCL && window.HCCL.user && window.HCCL.user.uid) || "";
  /* Mirrors matchOpen() in firestore.rules. A legacy match (no lockAt) is
     never "open", so its entries are listable - it has none anyway. */
  const entriesListable = day => canEditApp() || !ENG.isOpen(day, nowMs());

  function watchEntries(dayId) {
    const H = window.HCCL;
    if (!usingFirestore || !dayId || !H || !H.user || !fsDb() || !fsApi()) return;
    const day = fDay(dayId); if (!day) return;
    const all = entriesListable(day);
    if (entUnsub && entDayId === dayId && entTid === fanTid && entAll === all) return; // idempotent
    stopEntries();
    const gen = ++entGen, tid = fanTid;
    entDayId = dayId; entTid = tid; entAll = all;
    const onErr = err => {
      if (gen !== entGen) return;
      console.warn("fantasy entries snapshot error:", err && err.code);
      // NEVER fallbackToLocal here: a broken entries listener must not drag the
      // whole module into "this device only" and hide the league from everyone.
      if (window.HCCLSync && !window.HCCLSync.isTerminal(err)) {
        const wait = window.HCCLSync.backoff(entRetries++);
        setTimeout(() => {
          if (gen !== entGen) return;
          entUnsub = null; entDayId = null; watchEntries(dayId);
        }, wait);
        return;
      }
      entLoaded = true; entries = [];
      onRemoteChange();
    };
    const take = list => {
      if (gen !== entGen) return;
      entries = list; entLoaded = true; entRetries = 0;
      myEntryCache.set(dayId, entries.find(e => e.id === myUid()) || null);
      adoptRemoteDraft();
      onRemoteChange();
    };
    try {
      entUnsub = all
        ? fsApi().onSnapshot(entryColl(dayId),
            snap => take(snap.docs.map(d => normEntry(d.id, d.data()))), onErr)
        : fsApi().onSnapshot(entryRef(dayId, myUid()),
            snap => take(snap.exists() ? [normEntry(snap.id, snap.data())] : []), onErr);
    } catch (e) { onErr(e); }
  }
  function stopEntries() {
    if (entUnsub) { try { entUnsub(); } catch (e) {} }
    entUnsub = null; entDayId = null; entTid = null;
    entries = []; entLoaded = false; entAll = false; entRetries = 0;
  }

  /* My own team arriving from the server (typically: I submitted it in another
     tab) seeds the builder - but only when I haven't started editing here, or
     I'd lose the picks I'm in the middle of making. */
  function adoptRemoteDraft() {
    if (UI.view !== "build" || !UI.draft || UI.draft.dirty || UI.guest || UI.editEntryId) return;
    const mine = entries.find(e => e.id === myUid());
    if (mine) UI.draft = draftFromEntry(mine);
  }

  /* The match list wants "have I entered?" for every match. Published matches
     answer from their own standings, so only the handful that are still open or
     awaiting results need a lookup - and each is fetched once. */
  async function ensureMyEntries() {
    const H = window.HCCL;
    if (!usingFirestore || !H || !H.user || !fsApi()) return;
    const want = F.days.filter(d => {
      const st = ENG.lockState(d, nowMs());
      return (st === ENG.OPEN || st === ENG.LOCKED)
        && !myEntryCache.has(d.id) && !myEntryFetching.has(d.id);
    });
    if (!want.length) return;
    want.forEach(d => myEntryFetching.add(d.id));
    await Promise.all(want.map(async d => {
      try {
        const snap = await fsApi().getDoc(entryRef(d.id, myUid()));
        myEntryCache.set(d.id, snap.exists() ? normEntry(snap.id, snap.data()) : null);
      } catch (e) {
        myEntryCache.set(d.id, null);   // treat an unreadable entry as "not entered"
      } finally { myEntryFetching.delete(d.id); }
    }));
    if (UI.sub === "matches" && UI.view === "list") renderFanBody();
  }

  /* ---------------- helpers ---------------- */
  const fid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const fanEl = () => document.getElementById("view-fantasy");
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  const fTeam = id => F.teams.find(t => t.id === id);
  const fPlayer = id => F.players.find(p => p.id === id);
  const fContestant = id => F.contestants.find(c => c.id === id);
  const fDay = id => F.days.find(d => d.id === id);
  // A player who has been deleted still sits in already-submitted teams. Naming
  // the gap keeps a standings row explainable instead of mysteriously short.
  const pname = id => { const p = fPlayer(id); return p ? p.name : "Removed player"; };
  const teamName = id => { const t = fTeam(id); return t ? t.name : "-"; };
  const cname = id => { const c = fContestant(id); return c ? c.name : "Unknown"; };
  const teamOf = pid => { const p = fPlayer(pid); return p ? p.teamId : ""; };
  const pickCtx = () => ({ teamOf, teamName });
  // Does the VIEWED tournament run an auction? Only labelling - a fixed-squad
  // tournament imports exactly the same way (its players are status:"sold" too).
  const fanHasAuction = () => !window.HCCLSeries || window.HCCLSeries.hasAuction();

  /* The countdown is decoration; request.time in the security rules is the
     authority. skewMs only stops the two disagreeing visibly - see submitEntry,
     which treats a rejected write as the real answer. */
  let skewMs = 0;
  const nowMs = () => Date.now() + skewMs;

  // Team logo for the Player of the Season board: resolved from the generated
  // js/asset-manifest.js (tools/gen-assets.js), which indexes every league's
  // badge folder by lowercased basename - the same set the home boards use.
  // Falls back to a coloured initial when no file matches.
  const FAN_TEAM_LOGO_INDEX = (typeof window !== "undefined" && window.HCCL_ASSETS
    && window.HCCL_ASSETS.teamLogoIndex) || {};
  const FAN_TEAM_COLORS = ["#e10600", "#f5b301", "#22c55e", "#3b82f6", "#a855f7", "#ec4899", "#14b8a6", "#f97316"];
  function fanTeamColor(name) {
    let h = 0; name = String(name || "");
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
    return FAN_TEAM_COLORS[Math.abs(h) % FAN_TEAM_COLORS.length];
  }
  function teamIcon(name) {
    const t = String(name || "").trim();
    if (!t || t === "-") return "";
    const p = FAN_TEAM_LOGO_INDEX[t.toLowerCase()]; // full path from the manifest
    return p
      ? `<span class="team-ico" title="${esc(t)}" style="background-image:url('${encodeURI(p)}')"></span>`
      : `<span class="team-ico" title="${esc(t)}" style="background:${fanTeamColor(t)}">${esc(t[0] ? t[0].toUpperCase() : "?")}</span>`;
  }
  function avatar(name, photo) {
    const n = String(name || "?").trim() || "?";
    return photo
      ? `<span class="fan-av" style="background-image:url('${esc(photo)}')"></span>`
      : `<span class="fan-av" style="background:${fanTeamColor(n)}">${esc(n[0].toUpperCase())}</span>`;
  }
  function fmtPts(n) { return String(Math.round((Number(n) || 0) * 100) / 100); }
  function today() { return new Date().toISOString().slice(0, 10); }
  function dayLabel(d) {
    if (!d) return "";
    const dt = new Date(d.date + "T00:00:00");
    const s = isNaN(dt.getTime()) ? (d.date || "Day") : dt.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
    return s + (d.label ? " · " + d.label : "");
  }
  function matchTitle(d) {
    const ids = (d && d.teamIds) || [];
    if (ids.length >= 2) return teamName(ids[0]) + " vs " + teamName(ids[1]);
    if (ids.length === 1) return teamName(ids[0]);
    return dayLabel(d) || "Match";
  }
  function medal(i) { return i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : String(i + 1); }
  // <input type="datetime-local"> speaks local time, Firestore stores epoch ms.
  function toLocalInput(ms) {
    if (!ms) return "";
    const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
    return isNaN(d) ? "" : d.toISOString().slice(0, 16);
  }
  const fromLocalInput = v => { const t = Date.parse(v); return isFinite(t) ? t : 0; };
  function fmtWhen(ms) {
    if (!ms) return "no closing time";
    const d = new Date(ms);
    return isNaN(d) ? "no closing time"
      : d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }

  let ftoastTimer;
  function ftoast(msg, kind = "") {
    const t = document.getElementById("toast"); if (!t) return;
    t.textContent = msg; t.className = "toast " + kind;
    clearTimeout(ftoastTimer); ftoastTimer = setTimeout(() => t.classList.add("hidden"), 2400);
  }

  /* ---------------- scoring (delegates to js/fantasy-engine.js) ---------------- */
  function dayPool(day) { return F.players.filter(p => day.teamIds.includes(p.teamId)); }
  const playerDayPoints = (day, playerId) => ENG.playerDayPoints(day, playerId);
  const entryPoints = (day, entry) => ENG.entryPoints(day, entry);

  /* Legacy inline entries wear the same shape as modern ones so the rest of the
     view never has to care which era a team came from. */
  const legacyToEntry = e => ({
    id: "c:" + e.contestantId, uid: "", name: cname(e.contestantId), photo: "", teamName: "",
    playerIds: e.playerIds, captainId: e.captainId, viceCaptainId: e.viceCaptainId,
    winnerPick: e.winnerPick || "", legacy: true,
  });
  /* Every team submitted for a match: the live subcollection (when it's the
     match we're listening to) plus any legacy inline ones. Both can coexist if
     an editor gives an old match a closing time. */
  function dayEntries(day) {
    if (!day) return [];
    const legacy = (day.entries || []).map(legacyToEntry);
    if (!usingFirestore || entDayId !== day.id) return legacy;
    return entries.concat(legacy);
  }
  const myEntry = day => {
    if (!day) return null;
    if (entDayId === day.id) return entries.find(e => e.id === myUid()) || null;
    return myEntryCache.get(day.id) || null;
  };
  function dayStandings(day) {
    return ENG.rowsForDay(day, dayEntries(day), cname);
  }
  function contestantStats() { return ENG.seasonRows(F.days, cname); }
  function playerStats() { return ENG.playerSeasonRows(F.days, F.players); }
  /* playerId -> season points, for the tile subtitles in the builder. */
  function playerPointsMap() {
    const m = new Map();
    playerStats().forEach(s => m.set(s.player.id, s.total));
    return m;
  }
  function currentDay() { return UI.dayId ? fDay(UI.dayId) : null; }
  const sortedDays = () => F.days.slice().sort((a, b) =>
    (b.lockAt || 0) - (a.lockAt || 0) || String(b.date || "").localeCompare(String(a.date || "")));

  /* ============================================================
     RENDER
     ============================================================ */
  function canEditApp() {
    const H = window.HCCL;
    return !H || !H.configured || H.canEdit();
  }
  let renderId = 0;
  function renderFantasy() {
    const v = fanEl(); if (!v) return;
    if (!canEditApp() && UI.sub === "manage") UI.sub = "matches";
    v.innerHTML = `
      <div class="view-head">
        <h2>FANTASY LEAGUE</h2>
        <div class="fan-subnav">
          ${subBtn("matches", "🏏 Matches")}
          ${subBtn("leaderboard", "🏆 Leaderboards")}
          ${subBtn("manage", "⚙️ Manage")}
        </div>
      </div>
      ${fsFellBack ? `<div class="card" style="border-color:var(--red)"><p class="hint" style="margin:0">⚠ ${esc(fsFellBackMsg)}. Showing this device only - changes won't sync and the cloud-upload button is hidden. Fix the cause (publish rules / disable ad-blocker) and reload.</p></div>` : ""}
      <div id="fan-body"></div>`;
    renderFanBody();
  }
  function subBtn(key, label) {
    return `<button class="fan-tab ${UI.sub === key ? "active" : ""}" data-fan-sub="${key}">${label}</button>`;
  }
  function renderFanBody() {
    const body = document.getElementById("fan-body"); if (!body) return;
    if (usingFirestore && !fsReady) { body.innerHTML = `<div class="card"><p class="hint">Loading league data…</p></div>`; return; }
    if (!canEditApp() && UI.sub === "manage") UI.sub = "matches";

    if (UI.sub === "leaderboard") body.innerHTML = renderLeaderboards();
    else if (UI.sub === "manage") body.innerHTML = renderManage();
    else body.innerHTML = renderMatchesSub();

    // data-render-id changes only on a STRUCTURAL render - the countdown ticker
    // must never bump it (see tick()).
    body.setAttribute("data-render-id", String(++renderId));
    seedTickState();

    // renderBuilder() only lays out the shell; the picked strip and save bar are
    // painted from UI.draft. Doing it here (rather than at the call site) is what
    // keeps them filled after a re-render triggered by a remote snapshot.
    if (UI.sub === "matches" && UI.view === "build") paintBuilder();

    const day = currentDay();
    if (UI.sub === "matches" && day && UI.view !== "list") watchEntries(day.id);
    if (UI.sub === "matches" && UI.view === "list") ensureMyEntries();
  }

  /* ---------- matches: list / builder / teams / editor forms ---------- */
  function renderMatchesSub() {
    if (!F.teams.length) {
      return `<div class="card"><h3>Nothing to play for yet</h3>
        <p class="hint">${canEditApp()
          ? "Add the tournament teams &amp; players first - open <b>⚙️ Manage</b>, or import them from the auction."
          : "The league hasn't been set up yet. Check back once an admin adds the teams."}</p>
        ${canEditApp() ? `<div class="form-row"><button class="btn btn-yellow" data-fan-sub="manage">Open Manage</button></div>` : ""}</div>`;
    }
    const day = currentDay();
    if (UI.view === "form") return renderMatchForm();
    if (day && UI.view === "build") return renderBuilder(day);
    if (day && UI.view === "teams") return renderTeamsView(day);
    if (day && UI.view === "scores") return renderScores(day);
    return renderMatchList();
  }

  function stateChip(day) {
    const st = ENG.lockState(day, nowMs());
    if (st === ENG.LEGACY) return `<span class="fan-clock is-legacy">📁 archived</span>`;
    if (st === ENG.PUBLISHED) return `<span class="fan-clock is-done">🏁 result in</span>`;
    if (st === ENG.LOCKED) return `<span class="fan-clock is-locked">🔒 entries closed</span>`;
    const left = day.lockAt - nowMs();
    return `<span class="fan-clock ${left < 600000 ? "is-closing" : ""}" data-fan-countdown="${day.lockAt}" data-fan-day="${day.id}">⏳ closes in ${esc(ENG.fmtCountdown(left))}</span>`;
  }

  function myStatusHtml(day) {
    const st = ENG.lockState(day, nowMs());
    if (st === ENG.LEGACY) return `<div class="fan-mc-you">Archived match</div>`;
    if (st === ENG.PUBLISHED) {
      const row = (day.standings || []).find(r => r.k === myUid());
      return row
        ? `<div class="fan-mc-you is-scored">🏁 You scored <b>${fmtPts(row.pts)}</b> pts</div>`
        : `<div class="fan-mc-you is-out">You didn't enter this one</div>`;
    }
    const mine = myEntry(day);
    if (mine) return `<div class="fan-mc-you is-in">✅ Your team is in</div>`;
    if (st === ENG.LOCKED) return `<div class="fan-mc-you is-out">You didn't enter this one</div>`;
    return `<div class="fan-mc-you">You haven't picked a team yet</div>`;
  }

  function ctaHtml(day) {
    const st = ENG.lockState(day, nowMs());
    if (st === ENG.OPEN) {
      const mine = myEntry(day);
      return `<button class="btn ${mine ? "btn-dark" : "btn-red"} fan-mc-cta" data-fan-open="${day.id}" data-fan-goto="build">${mine ? "Edit my team" : "Pick your team"}</button>`;
    }
    return `<button class="btn btn-dark fan-mc-cta" data-fan-open="${day.id}" data-fan-goto="teams">${st === ENG.PUBLISHED ? "Standings" : "View teams"}</button>`;
  }

  function renderMatchList() {
    const days = sortedDays();
    const newBtn = canEditApp()
      ? `<button class="btn btn-yellow" data-fan-new-match>＋ Create match</button>` : "";
    let html = `<div class="fan-list-head">
      <p class="hint">${days.length
        ? "Pick a match, choose your squad and lock in a captain before the deadline."
        : (canEditApp() ? "No matches yet - create the first one." : "No matches have been set up yet.")}</p>
      ${newBtn}</div>`;

    if (!days.length) return html;

    html += `<div class="fan-matches">`;
    days.forEach(d => {
      const st = ENG.lockState(d, nowMs());
      const ids = d.teamIds || [];
      html += `<div class="fan-match-card is-${st}">
        <div class="fan-mc-teams">
          <span class="fan-mc-team">${teamIcon(teamName(ids[0]))}<b>${esc(teamName(ids[0]))}</b></span>
          <span class="fan-mc-vs">vs</span>
          <span class="fan-mc-team">${teamIcon(teamName(ids[1]))}<b>${esc(teamName(ids[1]))}</b></span>
        </div>
        <div class="fan-mc-meta">${esc(dayLabel(d))}${d.teamSize ? ` · pick ${d.teamSize}` : ""}${d.maxPerTeam ? ` · max ${d.maxPerTeam}/team` : ""}</div>
        ${d.isPlayoff ? `<span class="fan-playoff-tag">🏆 PLAYOFF · +${ENG.PLAYOFF_BONUS} for the winner call</span>` : ""}
        ${stateChip(d)}
        ${myStatusHtml(d)}
        <div class="fan-mc-actions">${ctaHtml(d)}</div>
        ${adminRow(d, st)}
      </div>`;
    });
    return html + `</div>`;
  }

  function adminRow(day, st) {
    if (!canEditApp()) return "";
    const n = (entDayId === day.id && entLoaded) ? entries.length
      : (day.standings ? day.standings.length : null);
    return `<div class="fan-admin-row">
      ${n != null ? `<span class="fan-admin-count">👥 ${n}</span>` : ""}
      <button class="btn btn-dark btn-mini" data-fan-edit-match="${day.id}">✎ Match</button>
      <button class="btn btn-dark btn-mini" data-fan-open="${day.id}" data-fan-goto="scores">📝 Scores</button>
      ${st === ENG.OPEN ? `<button class="btn btn-dark btn-mini" data-fan-guest="${day.id}">➕ Guest</button>
      <button class="btn btn-dark btn-mini" data-fan-lock-now="${day.id}">🔒 Lock now</button>` : ""}
      <button class="btn btn-danger btn-mini" data-fan-del-day="${day.id}">🗑</button>
    </div>`;
  }

  /* ---------- the team builder ---------- */
  function draftFromEntry(e) {
    return {
      playerIds: e ? e.playerIds.slice() : [],
      captainId: e ? e.captainId : "",
      viceCaptainId: e ? e.viceCaptainId : "",
      winnerPick: e ? (e.winnerPick || "") : "",
      name: e ? (e.name || "") : "",
      teamName: e ? (e.teamName || "") : "",
      dirty: false,
    };
  }
  /* Who is this team for? Cloud + signed in = me. An editor adding a guest, or
     anyone in offline mode (where there is no auth at all), types a name. */
  const draftNeedsName = () => UI.guest || !usingFirestore;

  function renderBuilder(day) {
    if (!UI.draft) UI.draft = draftFromEntry(UI.editEntryId
      ? dayEntries(day).find(e => e.id === UI.editEntryId)
      : (draftNeedsName() ? null : myEntry(day)));

    const pts = playerPointsMap();
    const open = ENG.isOpen(day, nowMs());
    let html = `<div class="fan-builder">
      <div class="fan-builder-head">
        <button class="btn btn-dark btn-mini fan-back" data-fan-back>‹ Matches</button>
        <div class="fan-builder-title">${esc(matchTitle(day))}</div>
        ${stateChip(day)}
      </div>`;

    if (!open) {
      html += `<div class="card"><p class="hint">Entries for this match have closed - your team is locked in.</p></div>`;
      return html + `</div>` + renderTeamsView(day, true);
    }

    html += `<div class="card fan-builder-intro">
      <p class="hint">Pick <b>${day.teamSize}</b> player${day.teamSize === 1 ? "" : "s"} from the two squads${day.maxPerTeam ? `, at most <b>${day.maxPerTeam}</b> from either team` : ""}. Your captain scores <b>2×</b> and your vice-captain <b>1.5×</b>.${ENG.isPlayoff(day) ? ` This is a <b>playoff match</b>: also call the winner for <b>+${ENG.PLAYOFF_BONUS}</b> bonus points.` : ""} You can change your team until entries close.</p>
      <div class="form-row">
        ${draftNeedsName()
          ? `<label style="flex:1 1 200px">${UI.guest ? "Contestant's name" : "Your name"}<input id="fanEntryName" value="${esc(UI.draft.name)}" placeholder="e.g. Yasitha" ${UI.editEntryId ? "disabled" : ""}/></label>`
          : ""}
        <label style="flex:1 1 200px">Team name <span class="hint">(optional)</span><input id="fanTeamNameIn" value="${esc(UI.draft.teamName)}" placeholder="e.g. Thunder XI"/></label>
      </div>
    </div>`;

    // The two sticky regions ARE these elements, not something paintBuilder puts
    // inside them: position:sticky slides an element within its PARENT's box, so
    // a shrink-wrapped wrapper would leave it nowhere to travel.
    html += `<div id="fanPicked" class="card fan-picked-card"></div><div id="fanWinner"></div><div class="fan-squad-cols">`;
    (day.teamIds || []).forEach(tid => {
      const ps = F.players.filter(p => p.teamId === tid);
      html += `<div class="fan-squad-col" data-fan-col="${tid}">
        <div class="fan-squad-head">${teamIcon(teamName(tid))}<b>${esc(teamName(tid))}</b><span class="fan-squad-count" data-fan-count="${tid}"></span></div>
        <div class="fan-plist">`;
      if (!ps.length) html += `<p class="hint">No players in this squad.</p>`;
      ps.forEach(p => {
        html += `<button class="fan-ptile" data-fan-pick="${p.id}" data-fan-team="${tid}">
          <span class="fan-ptile-av">${esc((p.name || "?").trim()[0] || "?").toUpperCase()}</span>
          <span class="fan-ptile-main"><span class="fan-ptile-name">${esc(p.name)}</span><span class="fan-ptile-stat">${fmtPts(pts.get(p.id) || 0)} pts this season</span></span>
          <span class="fan-ptile-badge"></span>
        </button>`;
      });
      html += `</div></div>`;
    });
    html += `</div><div id="fanSaveBar" class="fan-savebar"></div></div>`;
    return html;
  }

  /* Surgical repaint: class toggles on the tiles plus innerHTML on the two
     regions that hold no focusable state. renderFanBody() is NEVER called from
     here - the draft would survive it (it lives in UI), but the scroll position
     and the name input's caret would not. */
  function paintBuilder() {
    const root = fanEl(); if (!root || !UI.draft) return;
    const day = currentDay(); if (!day) return;
    const d = UI.draft, picked = new Set(d.playerIds);

    root.querySelectorAll("[data-fan-pick]").forEach(el => {
      const pid = el.getAttribute("data-fan-pick");
      const on = picked.has(pid);
      el.classList.toggle("on", on);
      el.classList.toggle("is-c", pid === d.captainId);
      el.classList.toggle("is-vc", pid === d.viceCaptainId);
      const blocked = !on && !ENG.canPick(day, d, pid, pickCtx()).ok;
      el.classList.toggle("is-full", blocked);
      el.disabled = blocked && !UI.assign;
      const badge = el.querySelector(".fan-ptile-badge");
      if (badge) badge.textContent = pid === d.captainId ? "C" : pid === d.viceCaptainId ? "VC" : "";
    });
    root.querySelectorAll("[data-fan-count]").forEach(el => {
      const tid = el.getAttribute("data-fan-count");
      const n = ENG.countByTeam(d.playerIds, pickCtx())[tid] || 0;
      el.textContent = day.maxPerTeam ? `${n}/${day.maxPerTeam}` : String(n);
    });

    const strip = document.getElementById("fanPicked");
    if (strip) strip.innerHTML = pickedStripHtml(day);
    const win = document.getElementById("fanWinner");
    if (win) win.innerHTML = winnerPickHtml(day);
    const bar = document.getElementById("fanSaveBar");
    if (bar) bar.innerHTML = saveBarHtml(day);
  }

  function pickedStripHtml(day) {
    const d = UI.draft, size = day.teamSize || d.playerIds.length;
    let chips = d.playerIds.map(pid => {
      const tag = pid === d.captainId ? `<span class="cap">C</span>`
        : pid === d.viceCaptainId ? `<span class="vc">VC</span>` : "";
      return `<button class="fan-picked-chip" data-fan-unpick="${pid}" title="Remove">
        <span class="fen-pname">${esc(pname(pid))}</span>${tag}<span class="fan-x">✕</span></button>`;
    }).join("");
    for (let i = d.playerIds.length; i < size; i++) chips += `<span class="fan-picked-chip is-empty">+</span>`;

    const cName = d.captainId ? pname(d.captainId) : "";
    const vName = d.viceCaptainId ? pname(d.viceCaptainId) : "";
    return `<div class="fan-picked-strip">${chips}</div>
      <div class="fan-cvc-row">
        <button class="fan-cvc-slot ${UI.assign === "c" ? "is-armed" : ""} ${cName ? "is-set" : ""}" data-fan-assign="c">
          <span class="fan-cvc-k">Captain · 2×</span>
          <span class="fan-cvc-v">${cName ? esc(cName) : (UI.assign === "c" ? "tap a player…" : "tap to choose")}</span>
        </button>
        <button class="fan-cvc-slot ${UI.assign === "vc" ? "is-armed" : ""} ${vName ? "is-set" : ""}" data-fan-assign="vc">
          <span class="fan-cvc-k">Vice-captain · 1.5×</span>
          <span class="fan-cvc-v">${vName ? esc(vName) : (UI.assign === "vc" ? "tap a player…" : "tap to choose")}</span>
        </button>
      </div>`;
  }

  /* Playoff matches only: the extra call. It lives in its own region rather
     than inside the picked strip, because that strip is position:sticky -
     anything added to it makes the sticky header taller and, on a short screen,
     pushes the options underneath the sticky save bar. */
  function winnerPickHtml(day) {
    if (!ENG.isPlayoff(day)) return "";
    const picked = UI.draft.winnerPick || "";
    return `<div class="card fan-winner-pick">
      <div class="fan-winner-k">🏆 Who wins this playoff? <span class="hint">+${ENG.PLAYOFF_BONUS} if you call it</span></div>
      <div class="fan-winner-opts">
        ${(day.teamIds || []).map(tid => `<button class="fan-winner-opt ${picked === tid ? "is-on" : ""}" data-fan-winner="${tid}">
          ${teamIcon(teamName(tid))}<span>${esc(teamName(tid))}</span></button>`).join("")}
      </div>
    </div>`;
  }

  function saveBarHtml(day) {
    const v = ENG.validateEntry(day, UI.draft, pickCtx());
    const size = day.teamSize || 0;
    const existing = UI.editEntryId
      ? dayEntries(day).find(e => e.id === UI.editEntryId)
      : (draftNeedsName() ? null : myEntry(day));
    return `<span class="fan-savebar-count">${UI.draft.playerIds.length} / ${size} picked</span>
      <span class="fan-savebar-msg ${v.ok ? "is-ok" : "is-bad"}">${v.ok ? "Ready to submit" : esc(v.msg)}</span>
      ${existing ? `<button class="btn btn-danger btn-mini" data-fan-withdraw>Withdraw</button>` : ""}
      <button class="btn btn-red" data-fan-submit ${v.ok && !UI.saving ? "" : "disabled"}>${UI.saving ? "Saving…" : (existing ? "Update team" : "Submit team")}</button>`;
  }

  /* ---------- everyone's teams (post-lock), or just mine (pre-lock) ---------- */
  function renderTeamsView(day, bare) {
    const st = ENG.lockState(day, nowMs());
    const all = dayEntries(day);
    const hidden = !entriesListable(day);
    const list = hidden ? all.filter(e => e.id === myUid()) : all;

    let html = bare ? "" : `<div class="fan-builder-head">
      <button class="btn btn-dark btn-mini fan-back" data-fan-back>‹ Matches</button>
      <div class="fan-builder-title">${esc(matchTitle(day))}${day.isPlayoff ? ` <span class="fan-playoff-tag">🏆 PLAYOFF</span>` : ""}</div>
      ${stateChip(day)}
    </div>`;

    if (hidden) {
      html += `<div class="card fan-hidden-note"><p class="hint">🔒 Everyone's teams appear here the moment entries close, so nobody can copy a squad at the last minute. Until then you can only see your own.</p></div>`;
    }
    if (!list.length) {
      // The entries listener is armed AFTER this markup goes in, so on the first
      // paint of a match we simply don't know yet - say so rather than flashing
      // "nobody entered" at a match that is full of teams.
      const pending = usingFirestore && (entDayId !== day.id || !entLoaded);
      return html + `<div class="card"><p class="hint">${pending ? "Loading teams…"
        : hidden ? "You haven't entered this match."
        : "No teams were submitted for this match."}</p></div>`;
    }

    html += `<div class="fan-teams-grid">`;
    list.slice().sort((a, b) => entryPoints(day, b) - entryPoints(day, a)).forEach(e => {
      const mine = e.id === myUid();
      html += `<div class="card fan-team-card ${mine ? "is-me" : ""}">
        <div class="fan-tc-head">
          ${avatar(e.name, e.photo)}
          <span class="fan-tc-name">${esc(e.name)}${e.teamName ? `<span class="frr-sub">${esc(e.teamName)}</span>` : ""}</span>
          ${st === ENG.PUBLISHED || (day.hasResults) ? `<span class="fan-pts">${fmtPts(entryPoints(day, e))} pts</span>` : ""}
          ${canEditApp() && ENG.isOpen(day, nowMs()) ? `<button class="icon-btn del" data-fan-del-entry="${e.id}" title="Remove this team">✕</button>` : ""}
        </div>
        <div class="fan-entry-players">${e.playerIds.map(pid => playerChip(pid, e, day)).join("")}</div>
        ${winnerCallHtml(day, e)}
      </div>`;
    });
    html += `</div>`;
    return html + renderDayStandings(day);
  }

  /* One line per team card on a playoff match: who they called, and - once the
     result is in - whether it paid. Reads the same winnerBonus() the score uses,
     so the badge can never disagree with the number above it. */
  function winnerCallHtml(day, e) {
    if (!ENG.isPlayoff(day)) return "";
    const pick = e.winnerPick || "";
    if (!pick) return `<div class="fan-call is-none">No winner call</div>`;
    const decided = !!day.winnerTeamId;
    const hit = ENG.winnerBonus(day, e) > 0;
    const verdict = !decided ? "" : hit ? `<b class="is-hit">+${ENG.PLAYOFF_BONUS}</b>` : `<b class="is-miss">missed</b>`;
    return `<div class="fan-call ${decided ? (hit ? "is-hit" : "is-miss") : ""}">
      🏆 Called <b>${esc(teamName(pick))}</b> ${verdict}</div>`;
  }

  function playerChip(pid, e, day) {
    const tag = pid === e.captainId ? `<span class="cap">C</span>` : pid === e.viceCaptainId ? `<span class="vc">VC</span>` : "";
    const gone = !fPlayer(pid);
    let pts = "";
    if (day && day.hasResults) pts = `<span class="pchip-pts">${fmtPts(ENG.playerEntryPoints(day, e, pid))}</span>`;
    return `<div class="fan-pchip ${gone ? "is-gone" : ""}">
      <span class="fen-ico" aria-hidden="true">👤</span>
      <span class="fen-pname">${esc(pname(pid))}</span>${tag}${pts}
    </div>`;
  }

  /* ---------- editor: create / edit a match ---------- */
  function blankForm() {
    const ids = F.teams.map(t => t.id);
    const at = new Date(); at.setHours(at.getHours() + 3, 0, 0, 0);
    return {
      id: null, date: today(), label: "",
      teamA: ids[0] || "", teamB: ids[1] || "",
      teamSize: 6, maxPerTeam: 0, lockAt: at.getTime(), entryCount: 0,
      isPlayoff: false,
    };
  }
  function renderMatchForm() {
    const f = UI.form || (UI.form = blankForm());
    const editing = !!f.id;
    const frozen = f.entryCount > 0;
    const opts = (sel) => F.teams.map(t => `<option value="${t.id}" ${t.id === sel ? "selected" : ""}>${esc(t.name)}</option>`).join("");
    return `<div class="card fan-form">
      <h3>${editing ? "Edit match" : "New match"}</h3>
      ${frozen ? `<div class="fan-form-warn">⚠ ${f.entryCount} team${f.entryCount === 1 ? " has" : "s have"} already been submitted, so the two squads, the team size and the playoff setting are fixed - changing them would invalidate every entry. The date, label, per-team cap and closing time are still yours to change.
        <button class="btn btn-danger btn-mini" data-fan-clear-entries="${f.id}">Clear all entries</button></div>` : ""}
      <div class="form-row">
        <label style="flex:1 1 180px">Team A<select id="fanFormA" ${frozen ? "disabled" : ""}>${opts(f.teamA)}</select></label>
        <label style="flex:1 1 180px">Team B<select id="fanFormB" ${frozen ? "disabled" : ""}>${opts(f.teamB)}</select></label>
      </div>
      <div class="form-row">
        <label style="flex:1 1 150px">Match date<input type="date" id="fanFormDate" value="${esc(f.date)}"/></label>
        <label style="flex:1 1 150px">Label <span class="hint">(optional)</span><input type="text" id="fanFormLabel" value="${esc(f.label)}" placeholder="e.g. Match 12"/></label>
      </div>
      <div class="form-row">
        <label style="flex:1 1 150px">Players per team<input type="number" min="1" max="15" id="fanFormSize" value="${f.teamSize}" ${frozen ? "disabled" : ""}/></label>
        <label style="flex:1 1 190px">Max from one team <span class="hint">(blank = no limit)</span><input type="number" min="1" max="15" id="fanFormCap" value="${f.maxPerTeam || ""}" placeholder="no limit"/></label>
      </div>
      <label class="fan-check">
        <input type="checkbox" id="fanFormPlayoff" ${f.isPlayoff ? "checked" : ""} ${frozen ? "disabled" : ""}/>
        <span>This is a <b>playoff match</b> - contestants also pick who wins it, worth <b>+${ENG.PLAYOFF_BONUS}</b> bonus points on their total for this match if they call it right. Record the winner on the Scores page before you publish.</span>
      </label>
      <label>Entries close at<input type="datetime-local" id="fanFormLock" value="${toLocalInput(f.lockAt)}"/></label>
      <p class="hint">After this moment nobody can submit or change a team - moderators and admins included. To reopen, come back and push the time forward.</p>
      <div class="form-row">
        <button class="btn btn-red" data-fan-save-match>${editing ? "Save match" : "Create match"}</button>
        <button class="btn btn-dark" data-fan-cancel-match>Cancel</button>
      </div>
    </div>`;
  }

  /* ---------- editor: scores + publish ---------- */
  function renderScores(day) {
    const pool = dayPool(day);
    let html = `<div class="fan-builder-head">
      <button class="btn btn-dark btn-mini fan-back" data-fan-back>‹ Matches</button>
      <div class="fan-builder-title">${esc(matchTitle(day))}</div>
      ${stateChip(day)}
    </div><div class="card"><h3>Match scores</h3>`;
    if (!pool.length) return html + `<p class="hint">This match has no players - check the two squads.</p></div>`;
    if (day.isPlayoff) {
      const ids = day.teamIds || [];
      html += `<div class="fan-winner-box">
        <div class="fan-winner-k">🏆 Playoff result <span class="hint">- who won? Everyone who called it gets +${ENG.PLAYOFF_BONUS}.</span></div>
        <div class="fan-winner-opts">
          ${ids.map(tid => `<button class="fan-winner-opt ${day.winnerTeamId === tid ? "is-on" : ""}" data-fan-set-winner="${tid}">
            ${teamIcon(teamName(tid))}<span>${esc(teamName(tid))}</span></button>`).join("")}
          <button class="fan-winner-opt is-none ${!day.winnerTeamId ? "is-on" : ""}" data-fan-set-winner="">No result / tie</button>
        </div>
      </div>`;
    }
    html += `<p class="hint">Enter each player's runs &amp; wickets. Points = runs + wickets × 10. Saving scores doesn't reveal anything; publishing is what puts the points on the leaderboard.</p><div class="fan-results">`;
    (day.teamIds || []).forEach(tid => {
      const ps = F.players.filter(p => p.teamId === tid);
      if (!ps.length) return;
      html += `<div class="fan-results-team"><div class="fan-pool-team-name">${esc(teamName(tid))}</div>`;
      ps.forEach(p => {
        const perf = (day.performance && day.performance[p.id]) || {};
        html += `<div class="fan-res-row">
          <span class="frr-name">${esc(p.name)}</span>
          <div class="frr-inputs">
            <input type="number" min="0" inputmode="numeric" data-runs="${p.id}" value="${perf.runs != null ? perf.runs : ""}" placeholder="runs"/>
            <input type="number" min="0" inputmode="numeric" data-wkts="${p.id}" value="${perf.wickets != null ? perf.wickets : ""}" placeholder="wkts"/>
            <span class="frr-pts">${fmtPts(playerDayPoints(day, p.id))}</span>
          </div>
        </div>`;
      });
      html += `</div>`;
    });
    html += `</div>
      <div class="fan-publish-bar">
        <span class="fan-publish-state">${day.hasResults
          ? `Published${day.publishedAt ? " · " + fmtWhen(day.publishedAt) : ""}${day.standings ? ` · ${day.standings.length} ranked` : ""}`
          : "Not published - contestants can't see any points yet"}</span>
        <button class="btn btn-dark" data-fan-save-scores>Save scores</button>
        <button class="btn btn-yellow" data-fan-publish>${day.hasResults ? "Recalculate & republish" : "Publish points"}</button>
        ${day.hasResults ? `<button class="btn btn-danger" data-fan-unpublish>Unpublish</button>` : ""}
      </div></div>`;
    return html + renderDayStandings(day);
  }

  function renderDayStandings(day) {
    const rows = dayStandings(day);
    if (!day.hasResults || !rows.length) return "";
    let html = `<div class="card"><div class="fan-card-head"><h3>Standings - ${esc(matchTitle(day))}</h3><button class="btn btn-dark fan-share-btn" data-share-day title="Download as image">📷 Share</button></div>`;
    html += `<table class="fan-table"><thead><tr><th>#</th><th>Contestant</th><th class="num">Points</th></tr></thead><tbody>`;
    rows.forEach((row, i) => {
      html += `<tr><td>${medal(i)}</td><td>${esc(row.n)}</td><td class="num strong">${fmtPts(row.pts)}</td></tr>`;
    });
    return html + `</tbody></table></div>`;
  }

  /* ---------- leaderboards ---------- */
  function renderLeaderboards() {
    const cs = contestantStats(), ps = playerStats();
    return `<div class="fan-board-grid">
      <div class="card"><div class="fan-card-head"><h3>🏆 Contestants</h3><button class="btn btn-dark fan-share-btn" data-share-board="contestant" title="Download as image">📷 Share</button></div>
        ${boardTable(cs.map(s => ({ name: s.name, photo: s.photo, avg: s.avg, days: s.days, total: s.total })), "Contestant", "contestant")}</div>
      <div class="card"><div class="fan-card-head"><h3>⭐ Fantasy Player of the Season</h3><button class="btn btn-dark fan-share-btn" data-share-board="player" title="Download as image">📷 Share</button></div>
        ${boardTable(ps.map(s => ({ name: s.player.name, team: teamName(s.player.teamId), avg: s.avg, days: s.days, total: s.total })), "Player", "player")}</div>
    </div>`;
  }
  function boardTable(rows, label, kind) {
    if (!rows.length) return `<p class="hint">No results yet. Once a match is played and its points are published, the table fills in.</p>`;
    const head = kind === "player"
      ? `<th title="Team">Team</th><th class="num" title="Total points">Total</th>`
      : `<th class="num" title="Matches played">M</th><th class="num" title="Total points">Total</th>`;
    const cells = r => kind === "player"
      ? `<td>${teamIcon(r.team)}</td><td class="num strong">${fmtPts(r.total)}</td>`
      : `<td class="num">${r.days || 0}</td><td class="num strong">${fmtPts(r.total)}</td>`;
    return `<table class="fan-table">
      <thead><tr><th>#</th><th>${label}</th>${head}</tr></thead>
      <tbody>${rows.map((r, i) => `<tr>
        <td>${medal(i)}</td>
        <td>${esc(r.name)}${r.sub ? `<span class="frr-sub">${esc(r.sub)}</span>` : ""}</td>
        ${cells(r)}</tr>`).join("")}</tbody></table>`;
  }

  /* ---------- share leaderboard as image ---------- */
  function shareRankBadge(i) {
    const base = "width:48px;height:48px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:'Russo One',sans-serif;font-weight:700;font-size:24px;flex:none;";
    const grad = i === 0 ? "linear-gradient(135deg,#ffe066,#f5b301)"
      : i === 1 ? "linear-gradient(135deg,#dcdce4,#9a9aa4)"
      : i === 2 ? "linear-gradient(135deg,#e0975a,#a05a1e)" : "";
    return grad
      ? `<div style="${base}color:#1a1300;background:${grad};">${i + 1}</div>`
      : `<div style="${base}color:#9b9ba3;background:#2a2a2e;">${i + 1}</div>`;
  }
  function shareDateStr() {
    return new Date().toLocaleDateString(undefined, { day: "2-digit", month: "long", year: "numeric" });
  }
  // The branded off-screen card shell shared by every share image: season title,
  // subtitle, date, divider, the row body, and the footer. `innerHtml` is the table.
  function buildShareShell(subTitle, dateStr, innerHtml) {
    // Brand the share card with the VIEWED tournament (the header now carries
    // the site-wide "HC Community" brand, which would be wrong on a per-league card).
    const series = window.HCCLSeries;
    const viewing = series && series.viewing ? series.viewing() : null;
    const seasonTitle = (viewing && (viewing.short || viewing.name)) || "HCCL";
    const card = document.createElement("div");
    // Lay out at the origin (NOT off-screen via a huge negative offset - the
    // node's own position is copied onto html-to-image's clone, so left:-99999px
    // pushes the content outside the captured SVG => an all-black image). Use
    // position:absolute (NOT fixed): a fixed node taller than the viewport gets
    // clipped to the screen height, cutting off the lower rows. Absolute lets the
    // node take its full content height so the entire table is captured. We tuck
    // it behind the app with z-index:-1; do NOT use opacity/visibility to hide it
    // - those get cloned too and would blank the capture.
    card.style.cssText = "position:absolute;left:0;top:0;z-index:-1;pointer-events:none;" +
      "width:1080px;box-sizing:border-box;padding:52px 48px;" +
      "background:#0a0a0b;color:#f6f6f7;font-family:'Inter',system-ui,sans-serif;";
    card.innerHTML = `
      <div style="text-align:center;">
        <div style="font-family:'Russo One',sans-serif;font-weight:700;font-size:56px;letter-spacing:1px;line-height:1;color:#ffcc00;">${esc(seasonTitle)} - Fantasy</div>
        <div style="font-size:23px;letter-spacing:4px;text-transform:uppercase;color:#f6f6f7;margin-top:14px;">${esc(subTitle)}</div>
        <div style="font-size:16px;color:#9b9ba3;margin-top:10px;">${esc(dateStr)}</div>
      </div>
      <div style="height:3px;border-radius:3px;background:linear-gradient(90deg,transparent,#e10600,#f5b301,transparent);margin:26px 0 30px;"></div>
      <div style="max-width:840px;margin:0 auto;">${innerHtml}</div>
      <div style="margin-top:30px;text-align:center;color:#5a5a62;font-size:15px;letter-spacing:3px;text-transform:uppercase;">
        HC Champions League
      </div>`;
    return card;
  }
  function shareRows(rows, isPlayer) {
    const statCell = (val, hi) =>
      `<div style="width:120px;text-align:right;font-size:${hi ? 30 : 24}px;font-weight:${hi ? 800 : 600};color:${hi ? "#ffcc00" : "#f6f6f7"};">${val}</div>`;
    return `
        <div style="display:flex;align-items:center;padding:0 24px 14px;color:#9b9ba3;font-size:14px;letter-spacing:2px;text-transform:uppercase;">
          <div style="width:56px;">#</div>
          <div style="flex:1;">${isPlayer ? "Player" : "Contestant"}</div>
          <div style="width:120px;text-align:right;">Total</div>
        </div>
        ${rows.map(r => `
          <div style="display:flex;align-items:center;background:#161618;border:1px solid #34343a;border-radius:16px;padding:16px 24px;margin-bottom:10px;">
            <div style="width:56px;">${shareRankBadge(r.i)}</div>
            <div style="flex:1;min-width:0;padding-right:16px;">
              <div style="font-size:27px;font-weight:700;line-height:1.15;">${esc(r.name)}</div>
              ${r.sub ? `<div style="font-size:16px;color:#9b9ba3;margin-top:3px;">${esc(r.sub)}</div>` : ""}
            </div>
            ${statCell(fmtPts(r.total), true)}
          </div>`).join("")}`;
  }
  function buildShareCard(kind, stats) {
    const isPlayer = kind === "player";
    // Players board: top 10 only. Contestants board: everyone.
    const ranked = isPlayer ? stats.slice(0, 10) : stats;
    const rows = ranked.map((s, i) => isPlayer
      ? { i, name: s.player.name, sub: teamName(s.player.teamId), total: s.total }
      : { i, name: s.name, sub: "", total: s.total });
    const subTitle = isPlayer ? "Fantasy Player of the Season" : "Fantasy Leaderboard";
    return buildShareShell(subTitle, shareDateStr(), shareRows(rows, isPlayer));
  }
  function buildDayShareCard(day) {
    const rows = dayStandings(day).map((row, i) => ({ i, name: row.n, sub: "", total: row.pts }));
    return buildShareShell("Match Standings", shareDateStr(), shareRows(rows, false));
  }
  async function captureAndDownload(node, filename, doneMsg) {
    document.body.appendChild(node);
    try {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      const opts = { pixelRatio: 2, backgroundColor: "#0a0a0b", cacheBust: true, width: 1080, height: node.scrollHeight };
      // First render is unreliable (fonts/styles not embedded yet) and often
      // comes back blank - run it as a throwaway, then capture for real.
      await window.htmlToImage.toPng(node, opts);
      const dataUrl = await window.htmlToImage.toPng(node, opts);
      const link = document.createElement("a");
      link.download = filename;
      link.href = dataUrl; link.click();
      ftoast(doneMsg, "good");
    } catch (err) {
      ftoast("Could not generate image", "bad");
    } finally {
      node.remove();
    }
  }
  async function shareBoard(kind) {
    const lib = window.htmlToImage;
    if (!lib || typeof lib.toPng !== "function") { ftoast("Image library still loading - try again", "bad"); return; }
    const stats = kind === "player" ? playerStats() : contestantStats();
    if (!stats.length) { ftoast("No results to share yet", "bad"); return; }
    ftoast("Building image...", "");
    const node = buildShareCard(kind, stats);
    const filename = kind === "player" ? "hccl-player-of-season-leaderboard.png" : "hccl-contestants-leaderboard.png";
    await captureAndDownload(node, filename, "Leaderboard image downloaded");
  }
  async function shareDay() {
    const lib = window.htmlToImage;
    if (!lib || typeof lib.toPng !== "function") { ftoast("Image library still loading - try again", "bad"); return; }
    const day = currentDay();
    if (!day || !day.hasResults || !dayStandings(day).length) { ftoast("No results to share yet", "bad"); return; }
    ftoast("Building image...", "");
    const node = buildDayShareCard(day);
    await captureAndDownload(node, "hccl-match-standings.png", "Match standings image downloaded");
  }

  /* ---------- manage ---------- */
  function renderManage() {
    const teamOpts = F.teams.map(t => `<option value="${t.id}" ${UI.editPlayerId && fPlayer(UI.editPlayerId) && fPlayer(UI.editPlayerId).teamId === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("");
    return `<div class="fan-board-grid">
      <div class="card"><h3 id="fanTeamTitle">${UI.editTeamId ? "Edit Team" : "Add Team"}</h3>
        <label>Team name<input id="fanTeamName" value="${UI.editTeamId && fTeam(UI.editTeamId) ? esc(fTeam(UI.editTeamId).name) : ""}" placeholder="e.g. Wizard Titans"/></label>
        <div class="form-row"><button class="btn btn-red" data-save-team>${UI.editTeamId ? "Save" : "Add team"}</button>${UI.editTeamId ? `<button class="btn btn-dark" data-cancel-team>Cancel</button>` : ""}</div>
        <div class="mini-list">${F.teams.length ? F.teams.map(t => `<div class="mini-row"><span class="ml-name">${esc(t.name)}</span><span class="ml-sub">${F.players.filter(p => p.teamId === t.id).length} players</span><button class="icon-btn" data-edit-team="${t.id}">✎</button><button class="icon-btn del" data-del-team="${t.id}">✕</button></div>`).join("") : `<p class="hint">No teams yet.</p>`}</div>
      </div>

      <div class="card"><h3 id="fanPlayerTitle">${UI.editPlayerId ? "Edit Player" : "Add Player"}</h3>
        <label>Player name<input id="fanPlayerName" value="${UI.editPlayerId && fPlayer(UI.editPlayerId) ? esc(fPlayer(UI.editPlayerId).name) : ""}" placeholder="e.g. Yasitha"/></label>
        <label>Team<select id="fanPlayerTeam">${teamOpts || `<option value="">Add a team first</option>`}</select></label>
        <div class="form-row"><button class="btn btn-red" data-save-player>${UI.editPlayerId ? "Save" : "Add player"}</button>${UI.editPlayerId ? `<button class="btn btn-dark" data-cancel-player>Cancel</button>` : ""}</div>
        <p class="hint">${F.players.length} players in the pool.</p>
        <div class="mini-list">${F.players.length ? F.players.map(p => `<div class="mini-row"><span class="ml-name">${esc(p.name)}</span><span class="ml-sub">${esc(teamName(p.teamId))}</span><button class="icon-btn" data-edit-player="${p.id}">✎</button><button class="icon-btn del" data-del-player="${p.id}">✕</button></div>`).join("") : `<p class="hint">No players. Add teams first, or import from the auction.</p>`}</div>
      </div>

      <div class="card"><h3>Contestants <span class="hint">(legacy)</span></h3>
        <p class="hint">Older match days recorded contestants by name. New matches use each signed-in member's own account instead, so nothing is added here any more.</p>
        <div class="mini-list">${F.contestants.length ? F.contestants.map(c => `<div class="mini-row"><span class="ml-name">${esc(c.name)}</span><button class="icon-btn del" data-del-contestant="${c.id}">✕</button></div>`).join("") : `<p class="hint">No legacy contestants.</p>`}</div>
      </div>

      <div class="card"><h3>Data &amp; Backup</h3>
        <p class="hint">${fanHasAuction()
          ? "Pull tournament teams &amp; players straight from your auction squads (sold + retained)."
          : "Pull tournament teams &amp; players straight from this tournament's squads."}</p>
        <div class="form-row"><button class="btn btn-yellow" data-import-auction>⬇ ${fanHasAuction() ? "Import from auction" : "Import squads"}</button></div>
        <hr/>
        <div class="form-row"><button class="btn btn-dark" data-export>Export fantasy backup</button>
          <label class="btn btn-dark file-btn">Import backup<input type="file" id="fanImportFile" accept="application/json" hidden/></label></div>
        <hr/>
        ${usingFirestore ? `<p class="hint">Live cloud sync is on - everyone sees the same data. Copy this device's saved data into the shared cloud (one-time).</p>
        <div class="form-row"><button class="btn btn-yellow" data-cloud-upload>☁ Upload local data to cloud</button></div>
        <hr/>` : ""}
        <div class="form-row"><button class="btn btn-danger" data-reset>Erase fantasy data</button></div>
      </div>
    </div>`;
  }

  /* ============================================================
     ACTIONS
     ============================================================ */
  function openMatch(dayId, goto) {
    const day = fDay(dayId); if (!day) return;
    UI.dayId = dayId; UI.draft = null; UI.assign = null;
    UI.guest = false; UI.editEntryId = null;
    const st = ENG.lockState(day, nowMs());
    UI.view = goto === "scores" ? "scores"
      : goto === "build" && st === ENG.OPEN ? "build"
      : "teams";
    renderFanBody();
  }
  function backToList() {
    UI.view = "list"; UI.draft = null; UI.assign = null; UI.guest = false;
    UI.editEntryId = null; UI.form = null;
    stopEntries();
    renderFanBody();
  }

  function togglePick(pid) {
    const day = currentDay(); if (!day || !UI.draft) return;
    const d = UI.draft;
    // A slot is armed: this tap assigns the captaincy instead of picking.
    if (UI.assign) {
      if (d.playerIds.indexOf(pid) < 0) { ftoast("Pick the player first, then make them captain", "bad"); return; }
      assignRole(UI.assign, pid);
      return;
    }
    const i = d.playerIds.indexOf(pid);
    if (i >= 0) {
      d.playerIds.splice(i, 1);
      if (d.captainId === pid) d.captainId = "";
      if (d.viceCaptainId === pid) d.viceCaptainId = "";
    } else {
      const can = ENG.canPick(day, d, pid, pickCtx());
      if (!can.ok) { ftoast(can.msg, "bad"); return; }
      d.playerIds.push(pid);
    }
    d.dirty = true;
    paintBuilder();
  }
  /* Handing the armband to the current vice-captain (or vice versa) swaps the
     two rather than leaving one role empty - that's what people expect. */
  function assignRole(role, pid) {
    const d = UI.draft; if (!d) return;
    if (role === "c") {
      if (d.viceCaptainId === pid) d.viceCaptainId = d.captainId;
      d.captainId = pid;
    } else {
      if (d.captainId === pid) d.captainId = d.viceCaptainId;
      d.viceCaptainId = pid;
    }
    UI.assign = null; d.dirty = true;
    paintBuilder();
  }
  function armAssign(role) {
    if (!UI.draft) return;
    UI.assign = UI.assign === role ? null : role;
    paintBuilder();
  }

  function readNameInputs() {
    const root = fanEl(); if (!root || !UI.draft) return;
    const n = root.querySelector("#fanEntryName"), t = root.querySelector("#fanTeamNameIn");
    if (n) UI.draft.name = (n.value || "").trim();
    if (t) UI.draft.teamName = (t.value || "").trim();
  }

  /* Tapping the same team again clears the call, so a pick is never a trap -
     the save bar then tells them one is still needed. */
  function pickWinner(teamId) {
    const day = currentDay(), d = UI.draft;
    if (!day || !d || !ENG.isPlayoff(day)) return;
    if (!(day.teamIds || []).includes(teamId)) return;
    d.winnerPick = d.winnerPick === teamId ? "" : teamId;
    d.dirty = true;
    paintBuilder();
  }

  async function submitEntry() {
    const day = currentDay(), d = UI.draft;
    if (!day || !d) return;
    readNameInputs();
    const v = ENG.validateEntry(day, d, pickCtx());
    if (!v.ok) { ftoast(v.msg, "bad"); return; }
    if (!ENG.isOpen(day, nowMs())) { ftoast("Entries have closed", "bad"); renderFanBody(); return; }
    if (draftNeedsName() && !d.name) { ftoast("Enter a name for this team", "bad"); return; }

    // Offline / no Firebase: there is no auth and no entries collection, so the
    // legacy inline array is the only store available. Same shape it always had.
    if (!usingFirestore) {
      let c = F.contestants.find(x => x.name.toLowerCase() === d.name.toLowerCase());
      if (!c) { c = { id: fid("c"), name: d.name }; F.contestants.push(c); }
      const ex = day.entries.find(e => e.contestantId === c.id);
      const pick = ENG.isPlayoff(day) ? (d.winnerPick || "") : "";
      if (ex) { ex.playerIds = d.playerIds.slice(); ex.captainId = d.captainId; ex.viceCaptainId = d.viceCaptainId; ex.winnerPick = pick; }
      else day.entries.push({ id: fid("e"), contestantId: c.id, playerIds: d.playerIds.slice(), captainId: d.captainId, viceCaptainId: d.viceCaptainId, winnerPick: pick });
      saveF(); backToList(); ftoast("Team saved", "good");
      return;
    }

    const H = window.HCCL, fs = fsApi();
    let entryId = UI.editEntryId || "";
    if (!entryId) {
      entryId = UI.guest ? ENG.guestId(d.name) : myUid();
      if (!entryId) { ftoast(UI.guest ? "That name can't be used - try letters and numbers" : "Sign in to enter a team", "bad"); return; }
    }
    const existing = dayEntries(day).find(e => e.id === entryId);
    const sentAt = Date.now();
    const data = {
      uid: UI.guest ? "" : myUid(),
      name: UI.guest ? d.name : (H.user.displayName || H.user.email || "Member"),
      photo: UI.guest ? "" : (H.user.photoURL || ""),
      teamName: d.teamName || "",
      playerIds: d.playerIds.slice(), captainId: d.captainId, viceCaptainId: d.viceCaptainId,
      // Only sent for playoff matches: the rules allowlist accepts the key but a
      // normal match has nothing to predict, so don't store a dead field on it.
      ...(ENG.isPlayoff(day) ? { winnerPick: d.winnerPick || "" } : {}),
      createdAt: existing && existing.createdAt ? existing.createdAt : sentAt,
      updatedAt: fs.serverTimestamp ? fs.serverTimestamp() : sentAt,
    };

    UI.saving = true; paintBuilder();
    try {
      await fs.setDoc(entryRef(day.id, entryId), data);
      myEntryCache.delete(day.id);
      d.dirty = false;
      ftoast(UI.guest ? "Guest team saved" : "Your team is in", "good");
      UI.saving = false;
      backToList();
      return;
    } catch (e) {
      // The SERVER's clock is the authority. A permission-denied here means the
      // deadline passed while our countdown still said otherwise - or that the
      // rules haven't been published yet.
      console.error("fantasy entry save failed:", e);
      if (e && e.code === "permission-denied") ftoast("Entries have closed", "bad");
      else ftoast("Couldn't save your team", "bad");
    } finally {
      UI.saving = false;
      if (pendingRender) { pendingRender = false; renderFantasy(); }
      else renderFanBody();
    }
  }

  async function withdrawEntry(entryId) {
    const day = currentDay(); if (!day) return;
    const id = entryId || UI.editEntryId || myUid();
    if (!confirm("Remove this team from the match?")) return;
    if (!usingFirestore) {
      const e = day.entries.find(x => ("c:" + x.contestantId) === id);
      if (e) day.entries = day.entries.filter(x => x !== e);
      saveF(); backToList(); return;
    }
    try {
      await fsApi().deleteDoc(entryRef(day.id, id));
      myEntryCache.delete(day.id);
      ftoast("Team removed", "good");
      backToList();
    } catch (e) {
      console.error("fantasy entry delete failed:", e);
      ftoast(e && e.code === "permission-denied" ? "Entries have closed" : "Couldn't remove the team", "bad");
    }
  }

  /* ---------- editor actions ---------- */
  async function openMatchForm(dayId) {
    if (!dayId) { UI.form = blankForm(); UI.view = "form"; UI.dayId = null; renderFanBody(); return; }
    const day = fDay(dayId); if (!day) return;
    const ids = day.teamIds || [];
    UI.dayId = dayId;
    UI.form = {
      id: day.id, date: day.date || today(), label: day.label || "",
      teamA: ids[0] || "", teamB: ids[1] || "",
      teamSize: day.teamSize || 6, maxPerTeam: day.maxPerTeam || 0,
      lockAt: day.lockAt || 0, entryCount: 0,
      isPlayoff: !!day.isPlayoff,
    };
    UI.view = "form";
    renderFanBody();
    // The squads and size are frozen once anyone has entered, because the rules
    // validate each write against the CURRENT teamSize: changing it would leave
    // existing entries scoreable but un-editable by their owners.
    if (usingFirestore) {
      try {
        const snap = await fsApi().getDocs(entryColl(day.id));
        const n = snap.size + (day.entries || []).length;
        if (UI.form && UI.form.id === day.id && n !== UI.form.entryCount) {
          UI.form.entryCount = n;
          if (UI.view === "form") renderFanBody();
        }
      } catch (e) { /* if we can't count, leave the fields editable */ }
    } else if (UI.form) {
      UI.form.entryCount = (day.entries || []).length;
      renderFanBody();
    }
  }
  function readMatchForm() {
    const root = fanEl(), f = UI.form; if (!root || !f) return;
    const val = sel => { const el = root.querySelector(sel); return el ? el.value : ""; };
    if (!f.entryCount) {
      f.teamA = val("#fanFormA"); f.teamB = val("#fanFormB");
      f.teamSize = Math.max(1, Math.min(15, parseInt(val("#fanFormSize"), 10) || 6));
      // Frozen alongside the squads: turning this on after people have entered
      // would hand the bonus only to whoever re-opens their team, and turning it
      // off would strip a pick the rules have already accepted.
      const pl = root.querySelector("#fanFormPlayoff");
      f.isPlayoff = pl ? !!pl.checked : !!f.isPlayoff;
    }
    f.date = val("#fanFormDate") || today();
    f.label = (val("#fanFormLabel") || "").trim();
    const cap = val("#fanFormCap");
    f.maxPerTeam = cap === "" ? 0 : Math.max(1, Math.min(15, parseInt(cap, 10) || 0));
    f.lockAt = fromLocalInput(val("#fanFormLock"));
  }
  function saveMatchForm() {
    readMatchForm();
    const f = UI.form; if (!f) return;
    if (!f.teamA || !f.teamB) { ftoast("Choose both teams", "bad"); return; }
    if (f.teamA === f.teamB) { ftoast("A match needs two different teams", "bad"); return; }
    if (!f.lockAt) { ftoast("Set the time entries close", "bad"); return; }
    if (f.maxPerTeam && f.maxPerTeam * 2 < f.teamSize) {
      ftoast(`Max ${f.maxPerTeam} per team makes ${f.teamSize} players impossible`, "bad"); return;
    }
    const H = window.HCCL;
    const who = (H && H.user && (H.user.email || H.user.uid)) || "";
    if (f.id) {
      const day = fDay(f.id); if (!day) return;
      day.date = f.date; day.label = f.label;
      day.maxPerTeam = f.maxPerTeam; day.lockAt = f.lockAt;
      if (!f.entryCount) {
        day.teamIds = [f.teamA, f.teamB]; day.teamSize = f.teamSize;
        day.isPlayoff = !!f.isPlayoff;
        if (!day.isPlayoff) day.winnerTeamId = "";   // no longer a playoff: drop the recorded result
      }
      ftoast("Match updated", "good");
    } else {
      F.days.unshift(normDay({
        id: fid("d"), date: f.date, label: f.label, teamIds: [f.teamA, f.teamB],
        teamSize: f.teamSize, maxPerTeam: f.maxPerTeam, lockAt: f.lockAt,
        isPlayoff: !!f.isPlayoff, winnerTeamId: "",
        performance: {}, entries: [], hasResults: false,
        createdAt: Date.now(), createdBy: who,
      }));
      ftoast("Match created", "good");
    }
    UI.form = null; UI.view = "list"; UI.dayId = null;
    saveF(); renderFanBody();
  }
  /* Record who won a playoff match. Stored on the match, not on any entry, so
     the bonus is recomputed from one source and editing it later is enough to
     correct everybody's total (re-publish to push it to the leaderboard). */
  function setPlayoffWinner(teamId) {
    const day = currentDay(); if (!day || !day.isPlayoff) return;
    if (teamId && !(day.teamIds || []).includes(teamId)) return;
    day.winnerTeamId = teamId || "";
    saveF(); renderFanBody();
    ftoast(teamId ? `Winner: ${teamName(teamId)}` : "Marked as no result - nobody gets the bonus", "good");
  }

  function lockNow(dayId) {
    const day = fDay(dayId); if (!day) return;
    if (!confirm("Close entries for this match right now? Nobody will be able to submit or change a team afterwards.")) return;
    day.lockAt = Date.now();
    saveF(); renderFanBody(); ftoast("Entries closed", "good");
  }
  function saveScores(publish) {
    const day = currentDay(); if (!day) return;
    const root = fanEl();
    // Start from what's already recorded rather than from {}. The form only
    // renders players whose CURRENT team is in this match, so a player
    // transferred since the match was scored has no inputs here - rebuilding
    // from scratch would silently delete the runs & wickets he actually made.
    const perf = Object.assign({}, day.performance);
    dayPool(day).forEach(p => {
      const r = root.querySelector(`[data-runs="${p.id}"]`);
      const w = root.querySelector(`[data-wkts="${p.id}"]`);
      perf[p.id] = { runs: Number(r && r.value) || 0, wickets: Number(w && w.value) || 0 };
    });
    day.performance = perf;
    if (!publish) { saveF(); renderFanBody(); ftoast("Scores saved - not published yet", "good"); return; }
    return publishPoints(day);
  }
  /* Publishing recomputes standings from scratch every time, so pressing it
     twice is harmless. Entries are re-read rather than taken from the live
     listener, which may be pointed at a different match. */
  async function publishPoints(day) {
    if (ENG.isOpen(day, nowMs()) &&
        !confirm("Entries are still open for this match - people can change their team after you publish. Publish anyway?")) return;
    // The bonus is frozen into the standings at publish time, so an unrecorded
    // playoff result silently pays nobody. Say so before it happens.
    if (day.isPlayoff && !day.winnerTeamId &&
        !confirm(`You haven't recorded who won this playoff match, so nobody gets the +${ENG.PLAYOFF_BONUS} bonus. Publish anyway?`)) return;
    let list = [];
    if (usingFirestore) {
      try {
        const snap = await fsApi().getDocs(entryColl(day.id));
        list = snap.docs.map(d => normEntry(d.id, d.data()));
      } catch (e) {
        console.error("fantasy publish: couldn't read entries", e);
        ftoast("Couldn't read the submitted teams - not published", "bad");
        return;
      }
    }
    const merged = list.concat((day.entries || []).map(legacyToEntry));
    const H = window.HCCL;
    day.standings = ENG.standingsFor(day, merged);
    day.hasResults = true;
    day.publishedAt = Date.now();
    day.publishedBy = (H && H.user && (H.user.email || H.user.uid)) || "";
    saveF(); renderFanBody();
    ftoast(`Points published - ${day.standings.length} team${day.standings.length === 1 ? "" : "s"} ranked`, "good");
  }
  function unpublish() {
    const day = currentDay(); if (!day) return;
    if (!confirm("Take these points off the leaderboard? The scores you entered are kept.")) return;
    day.hasResults = false; day.standings = null; day.publishedAt = 0; day.publishedBy = "";
    saveF(); renderFanBody(); ftoast("Points unpublished", "good");
  }
  async function clearAllEntries(dayId) {
    const day = fDay(dayId); if (!day) return;
    if (!confirm("Delete every team submitted for this match? This cannot be undone.")) return;
    await clearEntries(dayId);
    day.entries = [];
    myEntryCache.delete(dayId);
    if (UI.form && UI.form.id === dayId) UI.form.entryCount = 0;
    saveF(); renderFanBody(); ftoast("Submitted teams cleared", "good");
  }
  function updateRowPts(input) {
    const row = input.closest(".fan-res-row"); if (!row) return;
    const r = Number(row.querySelector("[data-runs]").value) || 0;
    const w = Number(row.querySelector("[data-wkts]").value) || 0;
    const pts = row.querySelector(".frr-pts"); if (pts) pts.textContent = fmtPts(r + w * 10);
  }

  async function delDay(id) {
    const d = fDay(id); if (!d) return;
    if (!confirm("Delete this match and every team submitted for it? This cannot be undone.")) return;
    // Firestore does not cascade: the entries subcollection outlives its match
    // document unless we clear it first, and orphans would keep being billed and
    // would reappear if the id were ever reused.
    await clearEntries(id);
    F.days = F.days.filter(x => x.id !== id);
    myEntryCache.delete(id);
    if (UI.dayId === id) { UI.dayId = null; UI.view = "list"; }
    saveF(); renderFanBody();
  }
  /* Delete every entry of a match. Used by delDay and by the editor's
     "Clear all entries" escape hatch. */
  async function clearEntries(dayId) {
    if (!usingFirestore) return;
    try {
      const snap = await fsApi().getDocs(entryColl(dayId));
      for (const d of snap.docs) await fsApi().deleteDoc(d.ref);
    } catch (e) {
      console.error("fantasy: couldn't clear entries for", dayId, e);
      ftoast("Couldn't remove the submitted teams", "bad");
    }
  }

  function saveTeam() {
    const el = fanEl().querySelector("#fanTeamName");
    const name = (el.value || "").trim();
    if (!name) { ftoast("Enter a team name", "bad"); return; }
    if (UI.editTeamId) { const t = fTeam(UI.editTeamId); if (t) t.name = name; UI.editTeamId = null; }
    else F.teams.push({ id: fid("t"), name });
    saveF(); renderFanBody(); ftoast("Team saved", "good");
  }
  function delTeam(id) {
    const t = fTeam(id); if (!t) return;
    if (!confirm(`Delete team "${t.name}" and its players?`)) return;
    const pids = new Set(F.players.filter(p => p.teamId === id).map(p => p.id));
    F.players = F.players.filter(p => p.teamId !== id);
    F.teams = F.teams.filter(x => x.id !== id);
    F.days.forEach(d => {
      d.teamIds = d.teamIds.filter(x => x !== id);
      pids.forEach(pid => delete d.performance[pid]);
      d.entries.forEach(e => {
        e.playerIds = e.playerIds.filter(x => !pids.has(x));
        if (pids.has(e.captainId)) e.captainId = null;
        if (pids.has(e.viceCaptainId)) e.viceCaptainId = null;
      });
    });
    if (UI.editTeamId === id) UI.editTeamId = null;
    saveF(); renderFanBody();
  }
  function savePlayer() {
    const root = fanEl();
    const name = (root.querySelector("#fanPlayerName").value || "").trim();
    const teamSel = root.querySelector("#fanPlayerTeam");
    const teamId = teamSel ? teamSel.value : "";
    if (!name) { ftoast("Enter a player name", "bad"); return; }
    if (!teamId) { ftoast("Add a team first", "bad"); return; }
    if (UI.editPlayerId) { const p = fPlayer(UI.editPlayerId); if (p) { p.name = name; p.teamId = teamId; } UI.editPlayerId = null; }
    else F.players.push({ id: fid("p"), name, teamId });
    saveF(); renderFanBody(); ftoast("Player saved", "good");
  }
  /* Matches whose entries are still live and could contain this player. Renaming
     is almost always what the editor actually wants. */
  function openMatchesUsing() {
    return F.days.filter(d => d.lockAt && !d.hasResults);
  }
  async function delPlayer(id) {
    const p = fPlayer(id); if (!p) return;
    const live = openMatchesUsing();
    if (live.length && usingFirestore) {
      let hits = 0, where = "";
      try {
        for (const d of live) {
          const snap = await fsApi().getDocs(entryColl(d.id));
          const n = snap.docs.filter(x => ((x.data() || {}).playerIds || []).includes(id)).length;
          if (n) { hits += n; if (!where) where = matchTitle(d); }
        }
      } catch (e) { /* can't check - fall through to the plain confirm */ }
      if (hits) {
        alert(`"${p.name}" is in ${hits} submitted team${hits === 1 ? "" : "s"} for ${where}. Rename the player instead, or clear that match's entries first.`);
        return;
      }
    }
    if (!confirm(`Delete player "${p.name}"? Teams already published keep their points; the player just shows as removed.`)) return;
    F.players = F.players.filter(x => x.id !== id);
    F.days.forEach(d => {
      delete d.performance[id];
      d.entries.forEach(e => {
        e.playerIds = e.playerIds.filter(x => x !== id);
        if (e.captainId === id) e.captainId = null;
        if (e.viceCaptainId === id) e.viceCaptainId = null;
      });
    });
    if (UI.editPlayerId === id) UI.editPlayerId = null;
    saveF(); renderFanBody();
  }
  function delContestant(id) {
    const c = fContestant(id); if (!c) return;
    if (!confirm(`Delete contestant "${c.name}" and all their legacy entries?`)) return;
    F.contestants = F.contestants.filter(x => x.id !== id);
    F.days.forEach(d => { d.entries = d.entries.filter(e => e.contestantId !== id); });
    saveF(); renderFanBody();
  }

  /* Import the squads of the tournament currently being VIEWED.
     Reads the live auction state through window.HCCLAuction (js/app.js), which
     follows HCCLSeries - NOT localStorage. In cloud mode app.js deliberately
     stops writing the local auction backup (Firestore is the source of truth),
     and it never writes it at all for a non-legacy tournament, so the old
     localStorage read here saw a stale blob and reported "nothing sold". */
  function importFromAuction() {
    const A = window.HCCLAuction;
    if (!A) { ftoast("Auction data isn't loaded yet - try again in a moment", "bad"); return; }
    const aTeams = A.teams();
    if (!aTeams.length) { ftoast("This tournament has no teams yet", "bad"); return; }
    // Retained and fixed-squad players are stored status:"sold" with a soldTo too
    // (app.js), so this one filter covers auctioned + retained + pre-assigned.
    const sold = A.players().filter(p => p.status === "sold" && p.soldTo);
    if (!sold.length) { ftoast("No players are sold/retained in this tournament yet", "bad"); return; }

    // The import rebuilds every id as ft_/fp_, so any team already submitted
    // would be left pointing at players that no longer exist. Make that cost
    // explicit rather than discovering it on the leaderboard.
    const live = F.days.filter(d => d.lockAt);
    if (live.length) {
      const msg = `This replaces every fantasy team & player with the current squads, and rebuilds their ids.\n\n`
        + `${live.length} match${live.length === 1 ? "" : "es"} already use the current ids - every team submitted for them would point at players that no longer exist.\n\n`
        + `Type IMPORT to continue.`;
      if (String(prompt(msg) || "").trim().toUpperCase() !== "IMPORT") return;
    } else if ((F.teams.length || F.players.length)
        && !confirm("Replace the fantasy teams & players with your current auction squads?")) return;

    F.teams = aTeams.map(t => ({ id: "ft_" + t.id, name: t.name }));
    const ids = new Set(F.teams.map(t => t.id));
    F.players = sold.map(p => ({ id: "fp_" + p.id, name: p.name, teamId: "ft_" + p.soldTo })).filter(p => ids.has(p.teamId));
    saveF(); renderFanBody(); ftoast(`Imported ${F.teams.length} teams and ${F.players.length} players`, "good");
  }
  // One-time migration: copy this device's localStorage fantasy data into the
  // shared cloud. Additive (won't delete cloud entries that aren't local).
  function uploadLocalToCloud() {
    if (!usingFirestore || !canEditApp()) { ftoast("Cloud editing isn't available", "bad"); return; }
    const local = loadF();
    const n = local.teams.length + local.players.length + local.days.length + local.contestants.length;
    if (!n) { ftoast("No saved data on this device to upload", "bad"); return; }
    if (!confirm(`Add this device's ${local.teams.length} teams, ${local.players.length} players and ${local.days.length} match days to the shared cloud?`)) return;
    FS_COLLS.forEach(coll => {
      const have = new Set(F[coll].map(x => x.id));
      local[coll].forEach(it => { if (!have.has(it.id)) F[coll].push(it); });
    });
    saveF(); renderFantasy(); ftoast("Uploading to the cloud…", "good");
  }
  function exportF() {
    const blob = new Blob([JSON.stringify(F, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = "hccl-fantasy-backup.json"; link.click();
    URL.revokeObjectURL(url); ftoast("Backup downloaded", "good");
  }
  function importF(e) {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const data = JSON.parse(r.result);
        if (!Array.isArray(data.days) && !Array.isArray(data.players)) throw new Error("bad");
        F = normalizeF(data); saveF(); renderFantasy(); ftoast("Backup imported", "good");
      } catch (err) { ftoast("Invalid fantasy backup file", "bad"); }
      e.target.value = "";
    };
    r.readAsText(f);
  }
  function resetF() {
    if (!confirm("Erase ALL fantasy data (teams, players, matches, entries)? This cannot be undone.")) return;
    F = defaultFantasy(); UI.sub = "manage"; resetUI();
    myEntryCache.clear(); stopEntries();
    saveF(); renderFantasy(); ftoast("Fantasy data erased", "good");
  }

  /* ============================================================
     COUNTDOWN TICKER
     Rewrites textContent and classes on nodes that already exist - never
     innerHTML, so a half-made selection, the scroll position and the caret in
     the team-name box all survive. Exactly one structural re-render happens,
     at the moment a deadline actually passes.
     ============================================================ */
  let tickTimer = null;
  const tickState = new Map();  // dayId -> "open" | "closed", the crossing latch

  function seedTickState() {
    tickState.clear();
    F.days.forEach(d => {
      if (d.lockAt) tickState.set(d.id, nowMs() < d.lockAt ? "open" : "closed");
    });
  }
  function tick() {
    const root = fanEl();
    // Inactive .hub-panels are display:none, so offsetParent is null and this is
    // a cheap no-op on every other page of the app.
    if (!root || root.offsetParent === null || document.hidden) return;
    const now = nowMs();
    let crossed = false;
    root.querySelectorAll("[data-fan-countdown]").forEach(el => {
      const at = Number(el.getAttribute("data-fan-countdown")) || 0;
      const left = at - now;
      el.textContent = left > 0 ? "⏳ closes in " + ENG.fmtCountdown(left) : "🔒 entries closed";
      el.classList.toggle("is-closing", left > 0 && left < 600000);
      el.classList.toggle("is-locked", left <= 0);
    });
    F.days.forEach(d => {
      if (!d.lockAt) return;
      const state = now < d.lockAt ? "open" : "closed";
      if (tickState.get(d.id) && tickState.get(d.id) !== state) crossed = true;
      tickState.set(d.id, state);
    });
    if (!crossed) return;
    // Same deferral guards as onRemoteChange - a crossing must not wipe an
    // editor mid-type either. focusout flushes the pending render.
    if (UI.saving) { pendingRender = true; return; }
    const ae = document.activeElement;
    if (ae && root.contains(ae) && ["INPUT", "SELECT", "TEXTAREA"].includes(ae.tagName)) { pendingRender = true; return; }
    renderFanBody();
  }
  function startTicker() {
    if (tickTimer) return;
    tickTimer = setInterval(tick, 1000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
  }

  /* ============================================================
     EVENTS (delegated on the persistent #view-fantasy container)
     ============================================================ */
  function onClick(e) {
    const t = e.target;
    let m;
    const sub = t.closest("[data-fan-sub]");
    if (sub) {
      UI.sub = sub.getAttribute("data-fan-sub");
      resetUI(); stopEntries(); renderFanBody(); return;
    }
    // --- matches / builder ---
    if ((m = t.closest("[data-fan-open]"))) return openMatch(m.getAttribute("data-fan-open"), m.getAttribute("data-fan-goto"));
    if (t.closest("[data-fan-back]")) return backToList();
    if ((m = t.closest("[data-fan-pick]"))) return togglePick(m.getAttribute("data-fan-pick"));
    if ((m = t.closest("[data-fan-unpick]"))) return togglePick(m.getAttribute("data-fan-unpick"));
    if ((m = t.closest("[data-fan-assign]"))) return armAssign(m.getAttribute("data-fan-assign"));
    if ((m = t.closest("[data-fan-winner]"))) return pickWinner(m.getAttribute("data-fan-winner"));
    if (t.closest("[data-fan-submit]")) return submitEntry();
    if (t.closest("[data-fan-withdraw]")) return withdrawEntry();
    if ((m = t.closest("[data-fan-del-entry]"))) return withdrawEntry(m.getAttribute("data-fan-del-entry"));
    // --- editor ---
    if (t.closest("[data-fan-new-match]")) return openMatchForm(null);
    if ((m = t.closest("[data-fan-edit-match]"))) return openMatchForm(m.getAttribute("data-fan-edit-match"));
    if (t.closest("[data-fan-save-match]")) return saveMatchForm();
    if (t.closest("[data-fan-cancel-match]")) return backToList();
    if ((m = t.closest("[data-fan-lock-now]"))) return lockNow(m.getAttribute("data-fan-lock-now"));
    if ((m = t.closest("[data-fan-guest]"))) {
      openMatch(m.getAttribute("data-fan-guest"), "build");
      UI.guest = true; UI.draft = draftFromEntry(null);
      renderFanBody(); return;
    }
    if ((m = t.closest("[data-fan-clear-entries]"))) return clearAllEntries(m.getAttribute("data-fan-clear-entries"));
    if ((m = t.closest("[data-fan-set-winner]"))) return setPlayoffWinner(m.getAttribute("data-fan-set-winner"));
    if (t.closest("[data-fan-save-scores]")) return saveScores(false);
    if (t.closest("[data-fan-publish]")) return saveScores(true);
    if (t.closest("[data-fan-unpublish]")) return unpublish();
    if ((m = t.closest("[data-fan-del-day]"))) return delDay(m.getAttribute("data-fan-del-day"));
    // --- manage ---
    if (t.closest("[data-save-team]")) return saveTeam();
    if (t.closest("[data-cancel-team]")) { UI.editTeamId = null; renderFanBody(); return; }
    if ((m = t.closest("[data-edit-team]"))) { UI.editTeamId = m.getAttribute("data-edit-team"); renderFanBody(); return; }
    if ((m = t.closest("[data-del-team]"))) return delTeam(m.getAttribute("data-del-team"));
    if (t.closest("[data-save-player]")) return savePlayer();
    if (t.closest("[data-cancel-player]")) { UI.editPlayerId = null; renderFanBody(); return; }
    if ((m = t.closest("[data-edit-player]"))) { UI.editPlayerId = m.getAttribute("data-edit-player"); renderFanBody(); return; }
    if ((m = t.closest("[data-del-player]"))) return delPlayer(m.getAttribute("data-del-player"));
    if ((m = t.closest("[data-del-contestant]"))) return delContestant(m.getAttribute("data-del-contestant"));
    // --- shared ---
    if ((m = t.closest("[data-share-board]"))) return shareBoard(m.getAttribute("data-share-board"));
    if (t.closest("[data-share-day]")) return shareDay();
    if (t.closest("[data-import-auction]")) return importFromAuction();
    if (t.closest("[data-export]")) return exportF();
    if (t.closest("[data-cloud-upload]")) return uploadLocalToCloud();
    if (t.closest("[data-reset]")) return resetF();
  }
  function onChange(e) {
    const t = e.target;
    if (t.id === "fanImportFile") return importF(e);
    if (t.hasAttribute("data-runs") || t.hasAttribute("data-wkts")) return updateRowPts(t);
  }

  /* ---------------- init ---------------- */
  function init() {
    const root = fanEl(); if (!root) return;
    root.addEventListener("click", onClick);
    root.addEventListener("change", onChange);
    root.addEventListener("input", e => {
      const el = e.target;
      if (!el.hasAttribute) return;
      if (el.hasAttribute("data-runs") || el.hasAttribute("data-wkts")) updateRowPts(el);
      // The name boxes are outside the repainted regions on purpose, but keep
      // the draft in step so a re-render never loses what was typed.
      else if (el.id === "fanEntryName" && UI.draft) { UI.draft.name = el.value.trim(); UI.draft.dirty = true; }
      else if (el.id === "fanTeamNameIn" && UI.draft) { UI.draft.teamName = el.value.trim(); UI.draft.dirty = true; }
    });
    // Flush a re-render that was deferred while the editor was typing.
    root.addEventListener("focusout", () => { if (pendingRender) { pendingRender = false; renderFantasy(); } });
    const tabs = document.getElementById("tabs");
    if (tabs) tabs.addEventListener("click", e => { if (e.target.closest('[data-tab="fantasy"]')) renderFantasy(); });
    // Real-time data: mirror Firestore into F, but only once SIGNED IN (reads
    // require auth). Without Firebase we stay on localStorage as before.
    if (window.HCCL && typeof window.HCCL.onChange === "function") {
      window.HCCL.onChange(H => {
        if (H && !H.user) { stopEntries(); myEntryCache.clear(); }
        fanMaybeStartSync();
        renderFantasy(); // re-render so gating + live data apply
      });
    }
    // Tournament switching (js/series.js) - resubscribe when the viewed one changes.
    if (window.HCCLSeries) window.HCCLSeries.onChange(fanOnSeriesChange);
    // Network / tab came back: retry the cloud instead of waiting for a reload.
    if (window.HCCLSync) window.HCCLSync.onReconnect(fanRetrySync);
    startTicker();
    renderFantasy();
  }
  // Public hook: the tournament page (series.js) hosts #view-fantasy as its
  // "Fantasy" panel and calls this when that inner tab opens.
  if (typeof window !== "undefined") window.HCCLFantasyView = { render: renderFantasy };
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
  }

  // Node-only test hook (inert in the browser - `module` is undefined there)
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { _load: d => { F = normalizeF(d); }, normDay, normEntry, dayPool, playerDayPoints, entryPoints, contestantStats, playerStats };
  }
})();
