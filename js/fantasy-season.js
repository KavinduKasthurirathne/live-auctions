/* ============================================================
   HCCL Fantasy - WEEKLY and OVERALL modes  (window.HCCLFantasySeason)

   Daily fantasy (js/fantasy.js) is untouched. This module adds two more
   modes alongside it, and editors choose which of the three members see.

   WEEKLY   An editor opens a week. Every member picks a team of 7 from the
            WHOLE tournament pool (every team, every player) plus a captain
            and vice-captain, editable until the week locks. Through the week
            editors enter runs & wickets - the same sheet as a daily match -
            then publish.
   OVERALL  One team of 7 for the whole season. Free to build and rebuild
            until the editor locks the season; after that the ONLY change is a
            swap: bring in a player from the pool for one in your team. Three
            swaps per season, one per player brought in (swap all three at
            once and that's the lot). Captain / vice-captain may be changed in
            the same submission as a swap. Once the swaps are spent, the team
            is final.

   OVERALL HAS ITS OWN SCORES - nothing from the daily or weekly sheets.
   Editors publish score updates of every player's season-to-date runs &
   wickets (typed in, or filled from the tournament's imported stats sheet).
   Each update scores the gain since the previous one, with the team version
   in force when the update's first match started (the editor sets it;
   default: when the previous update went out) - so a swap never counts
   backwards.

   Where things live (prefix = [] for the legacy tournament, else
   ["tournaments", tid]):
     <prefix>/fantasy/league/settings/config     modes + season settings (editors)
     <prefix>/fantasy/league/weeks/{weekId}      the weeks + their sheets  (editors)
     <prefix>/fantasy/league/overallScores/{id}  Overall score updates     (editors)
     fantasyWeekly/{tid}/weeks/{weekId}/entries/{uid}   weekly teams
     fantasyOverall/{tid}/entries/{uid}                 season teams
   Entries sit outside fantasy/** for the same reason daily entries do - see
   firestore.rules. Cloud only: offline, only Daily is offered.
   ============================================================ */
(function () {
  "use strict";

  const ENG = window.HCCLFantasyEngine;
  const LEGACY_TID = "hccl-s6";
  const MODES = ["daily", "weekly", "overall"];
  const MODE_LABEL = { daily: "Daily", weekly: "Weekly", overall: "Overall" };
  const MODE_KEY = "hccl_fantasy_mode";

  /* ---------------- tiny helpers ---------------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  const say = (m, k) => { if (typeof window.toast === "function") window.toast(m, k); };
  const H = () => window.HCCL;
  const cloudOn = () => { const h = H(); return !!(h && h.configured && h.user && h.db && h.fs); };
  const canEdit = () => { const h = H(); return !!(h && h.canEdit && h.canEdit()); };
  const myUid = () => { const h = H(); return (h && h.user && h.user.uid) || ""; };
  const fs = () => H().fs;
  const db = () => H().db;
  const fmtPts = n => { const v = Math.round((Number(n) || 0) * 10) / 10; return String(v); };
  // Rank cell: gold / silver / bronze badges for the podium, plain numbers after.
  const medal = i => (i < 3 ? `<span class="rank r${i + 1}">${i + 1}</span>` : `<span class="rank">${i + 1}</span>`);
  const ic = (n, c) => (window.HCCLUI ? window.HCCLUI.icon(n, c) : "");
  const skel = (kind, n, label) => (window.HCCLUI ? window.HCCLUI.skeleton(kind, n, label) : `<div class="card"><p class="hint">${label}</p></div>`);
  const pad2 = n => String(n).padStart(2, "0");
  function ymd(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
  function toLocalInput(ms) {
    if (!ms) return "";
    const d = new Date(ms);
    return `${ymd(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  function fromLocalInput(v) { const t = v ? new Date(v).getTime() : 0; return isNaN(t) ? 0 : t; }
  function whenLabel(ms) {
    if (!ms) return "-";
    const d = new Date(ms);
    return d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }
  function dateRange(w) {
    const f = s => { if (!s) return ""; const d = new Date(s + "T00:00:00"); return isNaN(d) ? s : d.toLocaleDateString(undefined, { day: "numeric", month: "short" }); };
    if (w.startDate && w.endDate) return `${f(w.startDate)} – ${f(w.endDate)}`;
    return f(w.startDate || w.endDate);
  }

  /* Server time. Swap versions are stamped by the client and the rules accept
     them only within a minute of request.time, so a phone whose clock is off
     would have every swap refused. The same-origin Date header is NTP-backed
     and free; good to about a second, which is plenty. */
  let skew = 0, skewDone = false;
  async function syncClock() {
    if (skewDone) return;
    try {
      const t0 = Date.now();
      const res = await fetch(location.href.split("#")[0], { method: "HEAD", cache: "no-store" });
      const t1 = Date.now();
      const hdr = res.headers.get("Date");
      if (hdr) {
        const server = new Date(hdr).getTime();
        // The header has whole-second precision; ignore sub-2s noise.
        const s = server - (t0 + t1) / 2;
        if (!isNaN(s) && Math.abs(s) > 2000) skew = Math.round(s);
      }
    } catch (e) { /* offline - keep the device clock */ }
    skewDone = true;
  }
  const now = () => Date.now() + skew;

  /* ---------------- the player pool (owned by js/fantasy.js) ---------------- */
  function pool() {
    const V = window.HCCLFantasyView;
    const p = V && V.pool ? V.pool() : null;
    return p || { teams: [], players: [], days: [] };
  }
  const teamById = id => pool().teams.find(t => t.id === id) || null;
  const playerById = id => pool().players.find(p => p.id === id) || null;
  const teamName = id => { const t = teamById(id); return t ? t.name : "-"; };
  const pname = id => { const p = playerById(id); return p ? p.name : "Removed player"; };
  const teamOf = pid => { const p = playerById(pid); return p ? p.teamId : ""; };
  const ctx = () => ({ teamOf, teamName });
  function teamIcon(name) {
    const V = window.HCCLFantasyView;
    return V && V.teamIcon ? V.teamIcon(name) : "";
  }
  function avatar(name, photo) {
    const V = window.HCCLFantasyView;
    if (V && V.avatar) return V.avatar(name, photo);
    const n = String(name || "?").trim() || "?";
    return `<span class="fan-av">${esc(n[0].toUpperCase())}</span>`;
  }
  function playerAv(p) {
    const L = window.HCCLPhotoLib;
    const ph = L && p ? L.forName(p.name) : "";
    return ph
      ? `<span class="fan-ptile-av has-photo" style="background-image:url('${ph}')"></span>`
      : `<span class="fan-ptile-av">${esc(((p && p.name) || "?").trim()[0] || "?").toUpperCase()}</span>`;
  }

  /* ---------------- normalisers ---------------- */
  function normCfg(d) {
    d = d || {};
    const m = d.modes || {}, o = d.overall || {};
    return {
      modes: {
        daily: m.daily !== false,           // default ON - every existing tournament keeps Daily
        weekly: m.weekly === true,
        overall: m.overall === true,
      },
      overall: {
        lockAt: Number(o.lockAt) || 0,
        teamSize: Number(o.teamSize) || ENG.DEFAULT_TEAM_SIZE,
        maxSwaps: o.maxSwaps != null ? Math.max(0, Number(o.maxSwaps) || 0) : ENG.DEFAULT_SWAPS,
        maxPerTeam: Number(o.maxPerTeam) || 0,
        freeCaptaincy: !!o.freeCaptaincy,
        closed: !!o.closed,
      },
    };
  }
  function normWeek(id, d) {
    d = d || {};
    return {
      id, label: d.label || "", startDate: d.startDate || "", endDate: d.endDate || "",
      lockAt: Number(d.lockAt) || 0,
      teamSize: Number(d.teamSize) || ENG.DEFAULT_TEAM_SIZE,
      maxPerTeam: Number(d.maxPerTeam) || 0,
      performance: (d.performance && typeof d.performance === "object") ? d.performance : {},
      hasResults: !!d.hasResults,
      standings: Array.isArray(d.standings) ? d.standings : null,
      createdAt: Number(d.createdAt) || 0,
      publishedAt: Number(d.publishedAt) || 0,
    };
  }
  const tsMs = v => (v && v.toMillis) ? v.toMillis() : (Number(v) || 0);
  function normWEntry(id, d) {
    d = d || {};
    return {
      id, uid: d.uid || "", name: d.name || "", photo: d.photo || "", teamName: d.teamName || "",
      playerIds: Array.isArray(d.playerIds) ? d.playerIds : [],
      captainId: d.captainId || "", viceCaptainId: d.viceCaptainId || "",
      createdAt: Number(d.createdAt) || 0, updatedAt: tsMs(d.updatedAt),
    };
  }
  function normOEntry(id, d) {
    d = d || {};
    return {
      ...normWEntry(id, d),
      swapsUsed: Number(d.swapsUsed) || 0,
      history: Array.isArray(d.history) ? d.history.map(v => ({
        at: Number(v && v.at) || 0,
        playerIds: Array.isArray(v && v.playerIds) ? v.playerIds : [],
        captainId: (v && v.captainId) || "", viceCaptainId: (v && v.viceCaptainId) || "",
      })) : [],
    };
  }
  function normScore(id, d) {
    d = d || {};
    const totals = {};
    Object.entries((d.totals && typeof d.totals === "object") ? d.totals : {}).forEach(([pid, v]) => {
      totals[pid] = { runs: Number(v && v.runs) || 0, wickets: Number(v && v.wickets) || 0 };
    });
    return { id, at: Number(d.at) || 0, teamsAt: Number(d.teamsAt) || 0, label: d.label || "",
      source: d.source || "manual", changed: Number(d.changed) || 0, baseline: !!d.baseline, totals };
  }

  /* ---------------- state ---------------- */
  let cfg = normCfg(null), cfgLoaded = false;
  let weeks = [], weeksLoaded = false;
  let oMine = null, oMineLoaded = false;
  let oAll = [], oAllLoaded = false, oAllUnsub = null;
  let oScores = [], oScoresLoaded = false;   // Overall score updates, oldest first
  let oDraft = null;     // the Scores sheet as typed: { label, source, vals: { pid: { runs, wickets } } }
  let oFill = null;      // what the last "fill from stats sheet" matched / missed
  const wEnt = { weekId: null, mode: null, list: [], loaded: false, unsub: null };
  const myWeekCache = new Map();             // weekId -> entry | null
  let tid = null, prefix = [], startedFor = "";
  const unsubs = [];

  const UI = {
    wTab: "weeks", wView: "list", weekId: null, wForm: null,
    oTab: "team", oView: "home",
  };
  let B = null;          // the active builder: { kind: "weekly"|"overall"|"swap", rules, weekId? }
  let draft = null;      // { playerIds, captainId, viceCaptainId, teamName, dirty }
  let assign = null;     // "c" | "vc" while a captaincy slot is armed
  let saving = false;
  let mounted = null;    // "weekly" | "overall" while a season mode owns #fan-body
  let pending = false;

  const cfgRef = () => fs().doc(db(), ...prefix, "fantasy", "league", "settings", "config");
  const weekRef = id => fs().doc(db(), ...prefix, "fantasy", "league", "weeks", id);
  const wEntryColl = wid => fs().collection(db(), "fantasyWeekly", tid, "weeks", wid, "entries");
  const wEntryRef = (wid, uid) => fs().doc(db(), "fantasyWeekly", tid, "weeks", wid, "entries", uid);
  const oColl = () => fs().collection(db(), "fantasyOverall", tid, "entries");
  const oRef = uid => fs().doc(db(), "fantasyOverall", tid, "entries", uid);
  const scoresColl = () => fs().collection(db(), ...prefix, "fantasy", "league", "overallScores");
  const scoreRef = id => fs().doc(db(), ...prefix, "fantasy", "league", "overallScores", id);

  const weekById = id => weeks.find(w => w.id === id) || null;
  const weekOpen = w => ENG.lockState(w, now()) === ENG.OPEN;
  const seasonSt = () => ENG.seasonState(cfg.overall, now());

  /* ---------------- sync ---------------- */
  function start() {
    const S = window.HCCLSeries;
    if (!cloudOn() || !ENG) return;
    if (S && !S.ready) return;
    const t = (S && S.viewingId()) || LEGACY_TID;
    // Keyed to the user too: "my season team" is a per-user listener, so a
    // different account signing in on this device must not inherit the last one's.
    if (unsubs.length && t === tid && startedFor === myUid()) return;
    stop();
    tid = t; prefix = S ? S.prefix() : []; startedFor = myUid();
    syncClock();
    const F = fs(), D = db();
    unsubs.push(F.onSnapshot(cfgRef(), snap => {
      cfg = normCfg(snap.exists() ? snap.data() : null);
      cfgLoaded = true;
      syncOverallAll();
      refresh(true);                     // the mode bar may appear/disappear, even on Daily
    }, err => { console.warn("fantasy config:", err && err.code); cfgLoaded = true; refresh(true); }));
    unsubs.push(F.onSnapshot(F.collection(D, ...prefix, "fantasy", "league", "weeks"), snap => {
      weeks = snap.docs.map(d => normWeek(d.id, d.data()));
      weeksLoaded = true;
      refresh();
    }, err => { console.warn("fantasy weeks:", err && err.code); weeksLoaded = true; refresh(); }));
    unsubs.push(F.onSnapshot(scoresColl(), snap => {
      oScores = snap.docs.map(d => normScore(d.id, d.data())).sort((a, b) => a.at - b.at);
      oScoresLoaded = true;
      refresh();
    }, err => { console.warn("overall scores:", err && err.code); oScoresLoaded = true; refresh(); }));
    const me = myUid();
    if (me) unsubs.push(F.onSnapshot(oRef(me), snap => {
      oMine = snap.exists() ? normOEntry(snap.id, snap.data()) : null;
      oMineLoaded = true;
      // An untouched build/swap draft is rebuilt from the fresh team on the next
      // render. A swap drafted against a stale team would be measured against
      // the wrong baseline - and refused by the rules.
      if (B && (B.kind === "overall" || B.kind === "swap") && draft && !draft.dirty) closeBuilder();
      refresh();
    }, err => { console.warn("overall entry:", err && err.code); oMineLoaded = true; refresh(); }));
  }
  function stop() {
    unsubs.splice(0).forEach(u => { try { u(); } catch (e) { /* gone */ } });
    if (oAllUnsub) { try { oAllUnsub(); } catch (e) { /* gone */ } oAllUnsub = null; }
    stopWeek();
    cfg = normCfg(null); cfgLoaded = false;
    weeks = []; weeksLoaded = false;
    oMine = null; oMineLoaded = false; oAll = []; oAllLoaded = false;
    oScores = []; oScoresLoaded = false; oDraft = null; oFill = null;
    myWeekCache.clear();
    B = null; draft = null; assign = null;
    // A new account (or tournament) starts on the front tabs, not wherever the
    // last person left off.
    UI.wTab = "weeks"; UI.wView = "list"; UI.weekId = null; UI.wForm = null;
    UI.oTab = "team"; UI.oView = "home";
  }
  /* Everyone's season teams: editors always; members once the season locks
     (the rules refuse the listing before then). */
  function syncOverallAll() {
    const st = seasonSt();
    const want = cloudOn() && cfg.modes.overall && (canEdit() || st === "swaps" || st === "closed");
    if (want && !oAllUnsub) {
      oAllUnsub = fs().onSnapshot(oColl(), snap => {
        oAll = snap.docs.map(d => normOEntry(d.id, d.data()));
        oAllLoaded = true; refresh();
      }, err => { console.warn("overall entries:", err && err.code); oAllLoaded = true; refresh(); });
    } else if (!want && oAllUnsub) {
      try { oAllUnsub(); } catch (e) { /* gone */ }
      oAllUnsub = null; oAll = []; oAllLoaded = false;
    }
  }
  /* One week's teams: everyone's once it locks (or for an editor), else just mine. */
  function watchWeek(weekId) {
    const w = weekById(weekId); if (!w || !cloudOn()) return;
    const listable = canEdit() || !weekOpen(w);
    const mode = listable ? "all" : "mine";
    if (wEnt.unsub && wEnt.weekId === weekId && wEnt.mode === mode) return;
    stopWeek();
    wEnt.weekId = weekId; wEnt.mode = mode; wEnt.list = []; wEnt.loaded = false;
    const onErr = err => { console.warn("weekly entries:", err && err.code); wEnt.loaded = true; refresh(); };
    if (listable) {
      wEnt.unsub = fs().onSnapshot(wEntryColl(weekId), snap => {
        wEnt.list = snap.docs.map(d => normWEntry(d.id, d.data()));
        wEnt.loaded = true;
        myWeekCache.set(weekId, wEnt.list.find(e => e.id === myUid()) || null);
        syncWeeklyDraft(weekId);
        refresh();
      }, onErr);
    } else {
      wEnt.unsub = fs().onSnapshot(wEntryRef(weekId, myUid()), snap => {
        const e = snap.exists() ? normWEntry(snap.id, snap.data()) : null;
        wEnt.list = e ? [e] : []; wEnt.loaded = true;
        myWeekCache.set(weekId, e);
        syncWeeklyDraft(weekId);
        refresh();
      }, onErr);
    }
  }
  /* The builder may open before my saved team has loaded. Until the user has
     touched the draft, keep it in step with what's saved - same courtesy the
     Daily builder extends. */
  function syncWeeklyDraft(weekId) {
    if (!B || B.kind !== "weekly" || B.weekId !== weekId || !draft || draft.dirty) return;
    const mine = myWeekCache.get(weekId);
    if (mine) openBuilder("weekly", B.rules, mine, { weekId });
  }
  function stopWeek() {
    if (wEnt.unsub) { try { wEnt.unsub(); } catch (e) { /* gone */ } }
    wEnt.unsub = null; wEnt.weekId = null; wEnt.mode = null; wEnt.list = []; wEnt.loaded = false;
  }
  /* "Your team is in" on the week cards: one cheap read per week, cached. */
  let myWeekFetching = false;
  async function ensureMyWeeks() {
    if (myWeekFetching || !cloudOn()) return;
    const missing = weeks.filter(w => !myWeekCache.has(w.id));
    if (!missing.length) return;
    myWeekFetching = true;
    let changed = false;
    for (const w of missing) {
      try {
        const s = await fs().getDoc(wEntryRef(w.id, myUid()));
        myWeekCache.set(w.id, s.exists() ? normWEntry(s.id, s.data()) : null);
        changed = true;
      } catch (e) { myWeekCache.set(w.id, null); }
    }
    myWeekFetching = false;
    if (changed) refresh();
  }

  /* ---------------- re-render plumbing ----------------
     Same courtesy js/fantasy.js extends: never repaint under someone's caret,
     never repaint mid-save. focusout flushes whatever was held back. */
  function refresh(evenIfDaily) {
    if (!mounted && !evenIfDaily) return;
    const V = window.HCCLFantasyView;
    if (!V || !V.refresh || !document.getElementById("view-fantasy")) return;
    if (saving) { pending = true; return; }
    const ae = document.activeElement, root = document.getElementById("view-fantasy");
    if (ae && root && root.contains(ae) && ["INPUT", "SELECT", "TEXTAREA"].includes(ae.tagName)) { pending = true; return; }
    V.refresh();
  }
  function flush() { if (pending) { pending = false; setTimeout(() => refresh(true), 0); } }

  /* ============================================================
     MODES
     ============================================================ */
  function enabledModes() {
    if (!cloudOn() || !cfgLoaded) return ["daily"];
    const on = MODES.filter(m => cfg.modes[m]);
    return on.length ? on : ["daily"];
  }
  /* Members see what's switched on. Editors see all three, so they can set a
     mode up (and preview it) before turning it on for everyone. Offline,
     Weekly and Overall can't exist, so nobody sees a mode bar at all. */
  function visibleModes(isEditor) {
    if (!cloudOn() || !cfgLoaded) return ["daily"];
    return isEditor ? MODES.slice() : enabledModes();
  }
  function savedMode() { try { return localStorage.getItem(MODE_KEY) || ""; } catch (e) { return ""; } }
  function rememberMode(m) { try { localStorage.setItem(MODE_KEY, m); } catch (e) { /* private window */ } }

  function modeBarHtml(current, isEditor) {
    const modes = visibleModes(isEditor);
    if (modes.length < 2) return "";
    return `<div class="fan-modebar" role="tablist" aria-label="Fantasy mode">${modes.map(m => `
      <button class="fan-mode ${m === current ? "active" : ""}" data-fan-mode="${m}" role="tab" aria-selected="${m === current}">
        ${MODE_LABEL[m]}${isEditor && !cfg.modes[m] ? `<span class="fan-mode-off" title="Hidden from members">off</span>` : ""}
      </button>`).join("")}</div>`;
  }

  function subnavHtml(mode) {
    const tab = (k, label, cur, attr) => `<button class="fan-tab ${cur === k ? "active" : ""}" ${attr}="${k}">${label}</button>`;
    if (mode === "weekly") {
      return tab("weeks", `${ic("calendar-range")}<span>Weeks</span>`, UI.wTab, "data-fs-wtab") + tab("board", `${ic("trophy")}<span>Leaderboard</span>`, UI.wTab, "data-fs-wtab");
    }
    if (mode === "overall") {
      const st = seasonSt();
      return tab("team", `${ic("shirt")}<span>My Team</span>`, UI.oTab, "data-fs-otab")
        + tab("board", `${ic("trophy")}<span>Leaderboard</span>`, UI.oTab, "data-fs-otab")
        + ((st === "swaps" || st === "closed" || canEdit()) ? tab("teams", `${ic("users")}<span>All Teams</span>`, UI.oTab, "data-fs-otab") : "")
        + (canEdit() ? tab("scores", `${ic("notebook-pen")}<span>Scores</span>`, UI.oTab, "data-fs-otab") + tab("season", `${ic("settings")}<span>Season</span>`, UI.oTab, "data-fs-otab") : "");
    }
    return "";
  }

  /* Card in Daily -> Manage: which modes members see. */
  function modesCardHtml() {
    if (!canEdit()) return "";
    if (!cloudOn()) {
      return `<div class="card"><h3>Fantasy modes</h3><p class="hint">Weekly and Overall fantasy run in the shared cloud - sign in to set them up. Daily works as before.</p></div>`;
    }
    const row = (m, title, desc) => `<label class="fan-check fs-mode-row">
        <input type="checkbox" data-fs-mode-toggle="${m}" ${cfg.modes[m] ? "checked" : ""}/>
        <span><b>${title}</b> - ${desc}</span></label>`;
    return `<div class="card fs-modes-card">
      <h3>Fantasy modes</h3>
      <p class="hint">Choose what members can play. Teams &amp; players below are shared by every mode. Editors always see all three so a mode can be set up before it's switched on.</p>
      ${row("daily", "Daily", "a team per match, as it works today")}
      ${row("weekly", "Weekly", "a team of 7 from the whole tournament, per week")}
      ${row("overall", "Overall", "one team of 7 for the season, with " + (cfg.overall.maxSwaps) + " swaps")}
    </div>`;
  }
  /* Writes ONLY the key that changed (a merge deep-merges the modes map), and
     applies it locally first. Writing the whole map built from `cfg` raced:
     tick two boxes quickly and the second write - built before the first one's
     snapshot arrived - switched the first mode straight back off. */
  async function toggleMode(m, on) {
    if (!canEdit() || !cloudOn() || !MODES.includes(m)) return;
    const next = { ...cfg.modes, [m]: !!on };
    if (!MODES.some(x => next[x])) { say("Keep at least one mode switched on", "bad"); refresh(true); return; }
    cfg.modes = next;
    try {
      await fs().setDoc(cfgRef(), { modes: { [m]: !!on } }, { merge: true });
      say(`${MODE_LABEL[m]} ${on ? "is now on for members" : "is hidden from members"}`, "good");
    } catch (e) {
      console.error(e);
      cfg.modes = { ...cfg.modes, [m]: !on };
      say("Couldn't save - check firestore.rules is published", "bad"); refresh(true);
    }
  }

  /* ============================================================
     RENDER ENTRY POINT (called by js/fantasy.js)
     ============================================================ */
  function render(mode, body) {
    mounted = mode;
    if (!body) return;
    if (!cloudOn()) {
      body.innerHTML = `<div class="card"><p class="hint">Weekly and Overall fantasy run in the shared cloud - sign in to play.</p></div>`;
      return;
    }
    if (!cfgLoaded) { body.innerHTML = skel("cards", 3, "Loading…"); return; }
    const offNote = (canEdit() && !cfg.modes[mode])
      ? `<div class="card fs-off-note"><p class="hint"><b>${MODE_LABEL[mode]} is hidden from members.</b> Set it up here, then switch it on.</p>
          <button class="btn btn-yellow btn-mini" data-fs-mode-on="${mode}">Switch on for members</button></div>` : "";
    if (!pool().teams.length) {
      body.innerHTML = offNote + `<div class="card"><h3>No teams yet</h3><p class="hint">${canEdit()
        ? "Add the tournament teams &amp; players first - <b>Daily → Manage</b>. Every mode uses the same pool."
        : "The league hasn't been set up yet."}</p></div>`;
      return;
    }
    body.innerHTML = offNote + (mode === "weekly" ? renderWeekly() : renderOverall());
    afterRender();
  }
  function unmount() { mounted = null; stopWeek(); }

  function afterRender() {
    if (B && draft && document.getElementById("fsPicked")) paint();
    if (mounted === "weekly") {
      if (UI.wView !== "list" && UI.weekId) watchWeek(UI.weekId);
      else { stopWeek(); ensureMyWeeks(); }
    }
    startTicker();
  }

  /* ============================================================
     SHARED BUILDER (weekly team, overall team, overall swap)
     ============================================================ */
  function stateChipWeek(w) {
    const st = ENG.lockState(w, now());
    if (st === ENG.PUBLISHED) return `<span class="fan-clock is-done">${ic("flag", "sm")}result in</span>`;
    if (st === ENG.LOCKED) return `<span class="fan-clock is-locked">${ic("lock", "sm")}locked - scoring</span>`;
    if (st === ENG.LEGACY) return `<span class="fan-clock is-locked">no lock time</span>`;
    const left = w.lockAt - now();
    return `<span class="fan-clock ${left < 600000 ? "is-closing" : ""}" data-fs-countdown="${w.lockAt}">locks in ${esc(ENG.fmtCountdown(left))}</span>`;
  }
  function seasonChip() {
    const st = seasonSt(), L = cfg.overall.lockAt;
    if (st === "setup") return `<span class="fan-clock is-locked">not set up</span>`;
    if (st === "closed") return `<span class="fan-clock is-done">${ic("flag", "sm")}season over</span>`;
    if (st === "swaps") return `<span class="fan-clock is-locked">${ic("repeat", "sm")}swaps only</span>`;
    const left = L - now();
    return `<span class="fan-clock ${left < 600000 ? "is-closing" : ""}" data-fs-countdown="${L}">teams lock in ${esc(ENG.fmtCountdown(left))}</span>`;
  }

  /* Season points per player across PUBLISHED weeks - the "form guide" on
     every tile, so picking from 50 names isn't a guess. */
  function poolPointsMap() {
    const m = new Map();
    weeks.filter(w => w.hasResults).forEach(w => {
      Object.keys(w.performance || {}).forEach(pid => m.set(pid, (m.get(pid) || 0) + ENG.playerDayPoints(w, pid)));
    });
    return m;
  }

  function openBuilder(kind, rules, base, extra) {
    B = Object.assign({ kind, rules }, extra || {});
    draft = {
      playerIds: base ? base.playerIds.slice() : [],
      captainId: base ? base.captainId : "", viceCaptainId: base ? base.viceCaptainId : "",
      teamName: base ? (base.teamName || "") : "", dirty: false,
    };
    assign = null;
  }
  function closeBuilder() { B = null; draft = null; assign = null; }

  function builderHtml(title, chip, intro, backAttr) {
    const pts = poolPointsMap();
    const isSwap = B.kind === "swap";
    let html = `<div class="fan-builder">
      <div class="fan-builder-head">
        <button class="btn btn-dark btn-mini fan-back" ${backAttr}>‹ Back</button>
        <div class="fan-builder-title">${esc(title)}</div>${chip}
      </div>
      <div class="card fan-builder-intro"><p class="hint">${intro}</p>
        ${isSwap ? "" : `<div class="form-row"><label style="flex:1 1 220px">Team name <span class="hint">(optional)</span>
          <input id="fsTeamName" value="${esc(draft.teamName)}" placeholder="e.g. Thunder XI"/></label></div>`}
      </div>
      <div id="fsPicked" class="card fan-picked-card"></div>
      <div class="fan-squad-cols fs-pool">`;
    pool().teams.forEach(t => {
      const ps = pool().players.filter(p => p.teamId === t.id);
      if (!ps.length) return;
      html += `<div class="fan-squad-col">
        <div class="fan-squad-head">${teamIcon(t.name)}<b>${esc(t.name)}</b><span class="fan-squad-count" data-fs-count="${t.id}"></span></div>
        <div class="fan-plist">${ps.map(p => `
          <button class="fan-ptile" data-fs-pick="${p.id}">
            ${playerAv(p)}
            <span class="fan-ptile-main"><span class="fan-ptile-name">${esc(p.name)}</span><span class="fan-ptile-stat">${fmtPts(pts.get(p.id) || 0)} pts so far</span></span>
            <span class="fan-ptile-badge"></span>
          </button>`).join("")}</div></div>`;
    });
    return html + `</div><div id="fsSaveBar" class="fan-savebar"></div></div>`;
  }

  function paint() {
    const root = document.getElementById("fan-body");
    if (!root || !B || !draft) return;
    const picked = new Set(draft.playerIds);
    root.querySelectorAll("[data-fs-pick]").forEach(el => {
      const pid = el.getAttribute("data-fs-pick");
      const on = picked.has(pid);
      el.classList.toggle("on", on);
      el.classList.toggle("is-c", pid === draft.captainId);
      el.classList.toggle("is-vc", pid === draft.viceCaptainId);
      const blocked = !on && !ENG.canPick(B.rules, draft, pid, ctx()).ok;
      el.classList.toggle("is-full", blocked);
      el.disabled = blocked && !assign;
      const badge = el.querySelector(".fan-ptile-badge");
      if (badge) badge.textContent = pid === draft.captainId ? "C" : pid === draft.viceCaptainId ? "VC" : "";
    });
    root.querySelectorAll("[data-fs-count]").forEach(el => {
      const t = el.getAttribute("data-fs-count");
      const n = ENG.countByTeam(draft.playerIds, ctx())[t] || 0;
      el.textContent = B.rules.maxPerTeam ? `${n}/${B.rules.maxPerTeam}` : (n ? String(n) : "");
    });
    const strip = document.getElementById("fsPicked");
    if (strip) strip.innerHTML = pickedHtml();
    const bar = document.getElementById("fsSaveBar");
    if (bar) bar.innerHTML = saveBarHtml();
  }

  function pickedHtml() {
    const size = B.rules.teamSize || draft.playerIds.length;
    const baseIds = B.kind === "swap" && oMine ? new Set(oMine.playerIds) : null;
    let chips = draft.playerIds.map(pid => {
      const tag = pid === draft.captainId ? `<span class="cap">C</span>` : pid === draft.viceCaptainId ? `<span class="vc">VC</span>` : "";
      const isNew = baseIds && !baseIds.has(pid);
      return `<button class="fan-picked-chip ${isNew ? "fs-new" : ""}" data-fs-unpick="${pid}" title="Remove">
        <span class="fen-pname">${esc(pname(pid))}</span>${isNew ? `<span class="fs-new-tag">IN</span>` : ""}${tag}<span class="fan-x">${ic("x", "sm")}</span></button>`;
    }).join("");
    for (let i = draft.playerIds.length; i < size; i++) chips += `<span class="fan-picked-chip is-empty">+</span>`;
    const out = baseIds ? oMine.playerIds.filter(pid => draft.playerIds.indexOf(pid) < 0) : [];
    const cN = draft.captainId ? pname(draft.captainId) : "", vN = draft.viceCaptainId ? pname(draft.viceCaptainId) : "";
    return `<div class="fan-picked-strip">${chips}</div>
      ${out.length ? `<div class="fs-out-line">Swapping out: ${out.map(pid => `<b>${esc(pname(pid))}</b>`).join(", ")}</div>` : ""}
      <div class="fan-cvc-row">
        <button class="fan-cvc-slot ${assign === "c" ? "is-armed" : ""} ${cN ? "is-set" : ""}" data-fs-assign="c">
          <span class="fan-cvc-k">Captain · 2×</span><span class="fan-cvc-v">${cN ? esc(cN) : (assign === "c" ? "tap a player…" : "tap to choose")}</span>
        </button>
        <button class="fan-cvc-slot ${assign === "vc" ? "is-armed" : ""} ${vN ? "is-set" : ""}" data-fs-assign="vc">
          <span class="fan-cvc-k">Vice-captain · 1.5×</span><span class="fan-cvc-v">${vN ? esc(vN) : (assign === "vc" ? "tap a player…" : "tap to choose")}</span>
        </button>
      </div>`;
  }

  function validateDraft() {
    if (B.kind === "swap") return ENG.validateSwap(cfg.overall, oMine, draft, ctx());
    return ENG.validateEntry(B.rules, draft, ctx());
  }
  function saveBarHtml() {
    const v = validateDraft();
    const size = B.rules.teamSize || 0;
    let extra = "", label = "Submit team", withdraw = "";
    if (B.kind === "swap") {
      const left = ENG.swapsLeft(cfg.overall, oMine);
      const n = v.swaps || 0;
      extra = `<span class="fs-swap-cost ${n > left ? "is-bad" : ""}">${ic("repeat", "sm")} ${n ? `uses ${n} swap${n === 1 ? "" : "s"} · ${Math.max(0, left - n)} left after` : `${left} swap${left === 1 ? "" : "s"} left`}</span>`;
      label = "Confirm swap";
    } else if (B.kind === "weekly") {
      const mine = myWeekCache.get(B.weekId);
      if (mine) { label = "Update team"; withdraw = `<button class="btn btn-danger btn-mini" data-fs-withdraw-week>Withdraw</button>`; }
    } else if (B.kind === "overall" && oMine) {
      label = "Update team";
      withdraw = `<button class="btn btn-danger btn-mini" data-fs-withdraw-overall>Withdraw</button>`;
    }
    return `<span class="fan-savebar-count">${draft.playerIds.length} / ${size} picked</span>${extra}
      <span class="fan-savebar-msg ${v.ok ? "is-ok" : "is-bad"}">${v.ok ? "Ready" : esc(v.msg)}</span>
      ${withdraw}
      <button class="btn btn-red" data-fs-submit ${v.ok && !saving ? "" : "disabled"}>${saving ? "Saving…" : label}</button>`;
  }

  function togglePick(pid) {
    if (!B || !draft) return;
    if (assign) {
      if (draft.playerIds.indexOf(pid) < 0) { say("Pick the player first, then give them the armband", "bad"); return; }
      assignRole(assign, pid); return;
    }
    const i = draft.playerIds.indexOf(pid);
    if (i >= 0) {
      draft.playerIds.splice(i, 1);
      if (draft.captainId === pid) draft.captainId = "";
      if (draft.viceCaptainId === pid) draft.viceCaptainId = "";
    } else {
      const can = ENG.canPick(B.rules, draft, pid, ctx());
      if (!can.ok) { say(can.msg, "bad"); return; }
      draft.playerIds.push(pid);
    }
    draft.dirty = true;
    paint();
  }
  function assignRole(role, pid) {
    if (role === "c") { if (draft.viceCaptainId === pid) draft.viceCaptainId = draft.captainId; draft.captainId = pid; }
    else { if (draft.captainId === pid) draft.captainId = draft.viceCaptainId; draft.viceCaptainId = pid; }
    assign = null; draft.dirty = true; paint();
  }
  function readTeamName() {
    const el = document.getElementById("fsTeamName");
    if (el && draft) draft.teamName = el.value.trim().slice(0, 60);
  }
  function me() {
    const u = H().user;
    return { uid: u.uid, name: (u.displayName || u.email || "Member").slice(0, 120), photo: u.photoURL || "" };
  }

  function teamChipsHtml(e, week) {
    return `<div class="fan-entry-players">${(e.playerIds || []).map(pid => {
      const tag = pid === e.captainId ? `<span class="cap">C</span>` : pid === e.viceCaptainId ? `<span class="vc">VC</span>` : "";
      const pts = week ? `<span class="pchip-pts">${fmtPts(ENG.playerEntryPoints(week, e, pid))}</span>` : "";
      return `<div class="fan-pchip ${playerById(pid) ? "" : "is-gone"}"><span class="fen-ico" aria-hidden="true">${ic("user", "sm")}</span>
        <span class="fen-pname">${esc(pname(pid))}</span>${tag}${pts}</div>`;
    }).join("")}</div>`;
  }
  function boardTableHtml(rows, cols) {
    if (!rows.length) return `<p class="hint">No points published yet.</p>`;
    return `<table class="fan-table"><thead><tr><th>#</th><th>Contestant</th>${cols.map(c => `<th class="num">${c.h}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((r, i) => `<tr class="${r.key === myUid() || r.k === myUid() ? "is-me" : ""}"><td>${medal(i)}</td><td>${esc(r.name || r.n || "")}</td>${cols.map(c => `<td class="num ${c.strong ? "strong" : ""}">${c.v(r)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  }

  /* ============================================================
     WEEKLY
     ============================================================ */
  function renderWeekly() {
    if (UI.wTab === "board") return weeklyBoardHtml();
    const w = UI.weekId ? weekById(UI.weekId) : null;
    if (UI.wView === "form") return weekFormHtml();
    if (w && UI.wView === "build") return weeklyBuilderHtml(w);
    if (w && UI.wView === "teams") return weekTeamsHtml(w);
    if (w && UI.wView === "scores") return weekScoresHtml(w);
    return weekListHtml();
  }

  function weekListHtml() {
    const list = weeks.slice().sort((a, b) => (b.lockAt || 0) - (a.lockAt || 0));
    let html = `<div class="card fan-intro"><p class="hint">${list.length
      ? `Pick your best ${ENG.DEFAULT_TEAM_SIZE} from <b>every team in the tournament</b> for the week, plus a captain (2×) and vice-captain (1.5×). Points come from the runs &amp; wickets scored through the week.`
      : (canEdit() ? "No weeks yet - open the first one." : "No weekly contest has been opened yet.")}</p>
      ${canEdit() ? `<div class="form-row"><button class="btn btn-yellow" data-fs-new-week>${ic("plus")}<span>New week</span></button></div>` : ""}</div>`;
    if (!weeksLoaded) return html + skel("cards", 3, "Loading weeks…");
    if (!list.length) return html;
    html += `<div class="fan-matches">`;
    list.forEach(w => {
      const st = ENG.lockState(w, now());
      const mine = myWeekCache.get(w.id);
      const known = myWeekCache.has(w.id);
      const status = st === ENG.OPEN
        ? (mine ? `<div class="fan-mc-you is-in">${ic("circle-check", "sm")} Your team is in</div>` : (known ? `<div class="fan-mc-you">You haven't picked yet</div>` : ""))
        : (mine ? `<div class="fan-mc-you is-in">${ic("circle-check", "sm")} You're in${w.hasResults && w.standings ? ` · ${fmtPts((w.standings.find(r => r.k === myUid()) || {}).pts || 0)} pts` : ""}</div>` : (known ? `<div class="fan-mc-you">You didn't enter</div>` : ""));
      const cta = st === ENG.OPEN
        ? `<button class="btn btn-red" data-fs-open-week="${w.id}" data-fs-goto="build">${mine ? "Edit team" : "Pick team"}</button>`
        : `<button class="btn btn-dark" data-fs-open-week="${w.id}" data-fs-goto="teams">View teams</button>`;
      html += `<div class="fan-match-card is-${st}">
        <div class="fan-mc-teams"><span class="fan-mc-team"><b>${esc(w.label || "Week")}</b></span></div>
        <div class="fan-mc-meta">${esc(dateRange(w))} · pick ${w.teamSize}${w.maxPerTeam ? ` · max ${w.maxPerTeam}/team` : ""}</div>
        ${stateChipWeek(w)}${status}
        <div class="fan-mc-actions">${cta}</div>
        ${canEdit() ? `<div class="fan-admin-row">
          <button class="btn btn-dark btn-mini" data-fs-edit-week="${w.id}">${ic("pencil", "sm")}<span>Week</span></button>
          <button class="btn btn-dark btn-mini" data-fs-open-week="${w.id}" data-fs-goto="scores">${ic("notebook-pen", "sm")}<span>Scores</span></button>
          ${st === ENG.OPEN ? `<button class="btn btn-dark btn-mini" data-fs-lock-week="${w.id}">${ic("lock", "sm")}<span>Lock now</span></button>` : ""}
          <button class="btn btn-danger btn-mini" data-fs-del-week="${w.id}" aria-label="Delete week" title="Delete week">${ic("trash-2", "sm")}</button></div>` : ""}
      </div>`;
    });
    return html + `</div>`;
  }

  function weeklyBuilderHtml(w) {
    if (!weekOpen(w)) { UI.wView = "teams"; return weekTeamsHtml(w); }
    if (!B || B.kind !== "weekly" || B.weekId !== w.id) {
      openBuilder("weekly", { teamSize: w.teamSize, maxPerTeam: w.maxPerTeam }, myWeekCache.get(w.id) || null, { weekId: w.id });
    }
    const intro = `Pick <b>${w.teamSize}</b> from any team${w.maxPerTeam ? `, at most <b>${w.maxPerTeam}</b> from one team` : ""}. Captain scores <b>2×</b>, vice-captain <b>1.5×</b>. Change it as often as you like until the week locks.`;
    return builderHtml(w.label || "Week", stateChipWeek(w), intro, "data-fs-back");
  }

  function weekTeamsHtml(w) {
    const st = ENG.lockState(w, now());
    const all = wEnt.weekId === w.id ? wEnt.list : [];
    const hidden = !canEdit() && weekOpen(w);
    let html = `<div class="fan-builder-head"><button class="btn btn-dark btn-mini fan-back" data-fs-back>‹ Weeks</button>
      <div class="fan-builder-title">${esc(w.label || "Week")}</div>${stateChipWeek(w)}</div>`;
    if (hidden) html += `<div class="card fan-hidden-note"><p class="hint">${ic("lock", "sm")} Everyone's teams appear when the week locks.</p></div>`;
    if (!wEnt.loaded || wEnt.weekId !== w.id) return html + skel("cards", 3, "Loading teams…");
    if (!all.length) return html + `<div class="card"><p class="hint">No teams were picked for this week.</p></div>`;
    const scored = st !== ENG.OPEN;
    html += `<div class="fan-teams-grid">`;
    all.slice().sort((a, b) => ENG.entryPoints(w, b) - ENG.entryPoints(w, a)).forEach(e => {
      html += `<div class="card fan-team-card ${e.id === myUid() ? "is-me" : ""}">
        <div class="fan-tc-head">${avatar(e.name, e.photo)}
          <span class="fan-tc-name">${esc(e.name)}${e.teamName ? `<span class="frr-sub">${esc(e.teamName)}</span>` : ""}</span>
          ${scored ? `<span class="fan-pts">${fmtPts(ENG.entryPoints(w, e))} pts${w.hasResults ? "" : " · live"}</span>` : ""}
          ${canEdit() && weekOpen(w) ? `<button class="icon-btn del" data-fs-del-wentry="${e.id}" title="Remove this team" aria-label="Remove this team">${ic("trash-2")}</button>` : ""}
        </div>${teamChipsHtml(e, scored ? w : null)}</div>`;
    });
    return html + `</div>`;
  }

  function blankWeekForm() {
    const n = weeks.length + 1;
    const start = new Date(), end = new Date(); end.setDate(end.getDate() + 6);
    const lock = new Date(); lock.setHours(lock.getHours() + 3, 0, 0, 0);
    return { id: null, label: `Week ${n}`, startDate: ymd(start), endDate: ymd(end), lockAt: lock.getTime(),
      teamSize: ENG.DEFAULT_TEAM_SIZE, maxPerTeam: 0, entryCount: 0 };
  }
  async function openWeekForm(id) {
    const w = id ? weekById(id) : null;
    UI.wForm = w ? { id: w.id, label: w.label, startDate: w.startDate, endDate: w.endDate, lockAt: w.lockAt,
      teamSize: w.teamSize, maxPerTeam: w.maxPerTeam, entryCount: 0 } : blankWeekForm();
    UI.wView = "form"; closeBuilder(); refresh(true);
    // Team size is frozen once anyone has entered - the rules check every write
    // against the CURRENT size, so changing it would strand existing teams.
    if (w) {
      try {
        const s = await fs().getDocs(wEntryColl(w.id));
        if (UI.wForm && UI.wForm.id === w.id) { UI.wForm.entryCount = s.size; refresh(true); }
      } catch (e) { /* can't count: leave it editable */ }
    }
  }
  function weekFormHtml() {
    const f = UI.wForm || (UI.wForm = blankWeekForm());
    const frozen = f.entryCount > 0;
    return `<div class="card fan-form">
      <h3>${f.id ? "Edit week" : "New week"}</h3>
      ${frozen ? `<div class="fan-form-warn">${ic("circle-alert")} ${f.entryCount} team${f.entryCount === 1 ? " has" : "s have"} been picked, so the team size is fixed.</div>` : ""}
      <div class="form-row">
        <label style="flex:1 1 180px">Label<input id="fsWLabel" value="${esc(f.label)}" placeholder="e.g. Week 3"/></label>
        <label style="flex:1 1 150px">From<input type="date" id="fsWStart" value="${esc(f.startDate)}"/></label>
        <label style="flex:1 1 150px">To<input type="date" id="fsWEnd" value="${esc(f.endDate)}"/></label>
      </div>
      <div class="form-row">
        <label style="flex:1 1 150px">Players per team<input type="number" min="1" max="15" id="fsWSize" value="${f.teamSize}" ${frozen ? "disabled" : ""}/></label>
        <label style="flex:1 1 190px">Max from one team <span class="hint">(blank = no limit)</span><input type="number" min="1" max="15" id="fsWCap" value="${f.maxPerTeam || ""}" placeholder="no limit"/></label>
      </div>
      <label>Teams lock at<input type="datetime-local" id="fsWLock" value="${toLocalInput(f.lockAt)}"/></label>
      <p class="hint">Before this moment members pick and change their team; after it nobody can, editors included. Set it before the week's first match.</p>
      <div class="form-row">
        <button class="btn btn-red" data-fs-save-week>${f.id ? "Save week" : "Open week"}</button>
        <button class="btn btn-dark" data-fs-back>Cancel</button>
      </div>
    </div>`;
  }
  async function saveWeekForm() {
    const f = UI.wForm; if (!f) return;
    const val = id => { const el = document.getElementById(id); return el ? el.value : ""; };
    f.label = val("fsWLabel").trim() || "Week";
    f.startDate = val("fsWStart"); f.endDate = val("fsWEnd");
    if (!f.entryCount) f.teamSize = Math.max(1, Math.min(15, parseInt(val("fsWSize"), 10) || ENG.DEFAULT_TEAM_SIZE));
    const cap = val("fsWCap");
    f.maxPerTeam = cap === "" ? 0 : Math.max(1, Math.min(15, parseInt(cap, 10) || 0));
    f.lockAt = fromLocalInput(val("fsWLock"));
    if (!f.lockAt) { say("Set when teams lock", "bad"); return; }
    if (f.startDate && f.endDate && f.endDate < f.startDate) { say("The week ends before it starts", "bad"); return; }
    if (f.maxPerTeam && f.maxPerTeam * pool().teams.length < f.teamSize) { say("That per-team cap makes a full team impossible", "bad"); return; }
    const data = { label: f.label, startDate: f.startDate, endDate: f.endDate, lockAt: f.lockAt,
      teamSize: f.teamSize, maxPerTeam: f.maxPerTeam };
    try {
      if (f.id) await fs().setDoc(weekRef(f.id), data, { merge: true });
      else {
        const id = "w" + Date.now().toString(36);
        await fs().setDoc(weekRef(id), { ...data, performance: {}, hasResults: false, standings: null,
          createdAt: Date.now(), createdBy: (H().user.email || "") });
      }
      say(f.id ? "Week updated" : "Week opened", "good");
      UI.wForm = null; UI.wView = "list";
      refresh(true);
    } catch (e) { console.error(e); say("Couldn't save the week", "bad"); }
  }
  async function lockWeekNow(id) {
    if (!confirm("Lock this week now? Nobody will be able to pick or change a team for it.")) return;
    try { await fs().setDoc(weekRef(id), { lockAt: now() }, { merge: true }); say("Week locked", "good"); }
    catch (e) { console.error(e); say("Couldn't lock the week", "bad"); }
  }
  async function deleteWeek(id) {
    const w = weekById(id); if (!w) return;
    if (!confirm(`Delete ${w.label || "this week"}, its scores and every team picked for it? This can't be undone.`)) return;
    try {
      const s = await fs().getDocs(wEntryColl(id));
      const batch = fs().writeBatch(db());
      s.docs.forEach(d => batch.delete(d.ref));
      batch.delete(weekRef(id));
      await batch.commit();
      myWeekCache.delete(id);
      say("Week deleted", "good");
    } catch (e) { console.error(e); say("Couldn't delete it", "bad"); }
  }

  async function submitWeekly() {
    const w = weekById(B.weekId); if (!w) return;
    readTeamName();
    const v = ENG.validateEntry(B.rules, draft, ctx());
    if (!v.ok) { say(v.msg, "bad"); return; }
    if (!weekOpen(w)) { say("This week has locked", "bad"); refresh(true); return; }
    const u = me(), existing = myWeekCache.get(w.id);
    const data = {
      uid: u.uid, name: u.name, photo: u.photo, teamName: draft.teamName || "",
      playerIds: draft.playerIds.slice(), captainId: draft.captainId, viceCaptainId: draft.viceCaptainId,
      createdAt: existing && existing.createdAt ? existing.createdAt : Date.now(),
      updatedAt: fs().serverTimestamp(),
    };
    saving = true; paint();
    try {
      await fs().setDoc(wEntryRef(w.id, u.uid), data);
      myWeekCache.set(w.id, normWEntry(u.uid, { ...data, updatedAt: Date.now() }));
      say(existing ? "Team updated" : "Your weekly team is in", "good");
      closeBuilder(); UI.wView = "list";
    } catch (e) {
      console.error(e);
      say(e && e.code === "permission-denied"
        ? (weekOpen(w) ? "The server refused this team - ask an admin to check firestore.rules is published" : "This week has locked")
        : "Couldn't save your team", "bad");
    } finally { saving = false; flush(); refresh(true); }
  }
  async function withdrawWeekly(entryId) {
    const w = weekById(UI.weekId); if (!w) return;
    const own = !entryId || entryId === myUid();
    if (!confirm(own ? "Withdraw your team for this week?" : "Remove this contestant's team?")) return;
    try {
      await fs().deleteDoc(wEntryRef(w.id, entryId || myUid()));
      if (own) { myWeekCache.set(w.id, null); closeBuilder(); UI.wView = "list"; }
      say("Team removed", "good"); refresh(true);
    } catch (e) { console.error(e); say("Couldn't remove it", "bad"); }
  }

  /* ---- scores ---- */
  function weekScoresHtml(w) {
    if (!canEdit()) { UI.wView = "teams"; return weekTeamsHtml(w); }
    const perf = w.performance || {};
    const inPool = new Set(pool().players.map(p => p.id));
    const orphans = Object.keys(perf).filter(pid => !inPool.has(pid));
    let html = `<div class="fan-builder-head"><button class="btn btn-dark btn-mini fan-back" data-fs-back>‹ Weeks</button>
      <div class="fan-builder-title">${esc(w.label || "Week")} · scores</div>${stateChipWeek(w)}</div>
      <div class="card"><h3>Runs &amp; wickets this week</h3>
      <p class="hint">Points = runs + wickets × 10. Update through the week as matches finish - saving doesn't reveal anything; <b>publishing</b> puts the week on the Weekly leaderboard. (Overall has its own sheet.)</p>
      <div class="form-row"><button class="btn btn-dark btn-mini" data-fs-fill-daily="${w.id}" title="Adds up every daily match dated ${esc(dateRange(w) || "in this week")}">⬇ Fill from daily matches${w.startDate ? ` (${esc(dateRange(w))})` : ""}</button></div>
      <div class="fan-results">`;
    pool().teams.forEach(t => {
      const ps = pool().players.filter(p => p.teamId === t.id);
      if (!ps.length) return;
      html += `<div class="fan-results-team"><div class="fan-pool-team-name">${esc(t.name)}</div>${ps.map(p => scoreRowHtml(w, p.id, p.name)).join("")}</div>`;
    });
    if (orphans.length) {
      html += `<div class="fan-results-team"><div class="fan-pool-team-name">No longer in the pool</div>${orphans.map(pid => scoreRowHtml(w, pid, pname(pid))).join("")}</div>`;
    }
    html += `</div><div class="fan-publish-bar">
        <button class="btn btn-dark" data-fs-save-scores>${ic("save")}<span>Save scores</span></button>
        ${w.hasResults
          ? `<button class="btn btn-yellow" data-fs-publish>${ic("megaphone")}<span>Re-publish</span></button><button class="btn btn-danger btn-mini" data-fs-unpublish>Unpublish</button>`
          : `<button class="btn btn-red" data-fs-publish>${ic("megaphone")}<span>Publish points</span></button>`}
      </div></div>`;
    return html;
  }
  function scoreRowHtml(w, pid, name) {
    const p = (w.performance || {})[pid] || {};
    return `<div class="fan-res-row"><span class="frr-name">${esc(name)}</span>
      <div class="frr-inputs">
        <input type="number" min="0" inputmode="numeric" data-fs-runs="${pid}" value="${p.runs != null ? p.runs : ""}" placeholder="runs"/>
        <input type="number" min="0" inputmode="numeric" data-fs-wkts="${pid}" value="${p.wickets != null ? p.wickets : ""}" placeholder="wkts"/>
        <span class="frr-pts" data-fs-rowpts="${pid}">${fmtPts(ENG.playerDayPoints(w, pid))}</span>
      </div></div>`;
  }
  /* Start from what's recorded, so a player who has left the pool keeps the
     runs he made (the same lesson as the daily scores page). */
  function readScores(w) {
    const root = document.getElementById("fan-body");
    const perf = Object.assign({}, w.performance || {});
    root.querySelectorAll("[data-fs-runs]").forEach(el => {
      const pid = el.getAttribute("data-fs-runs");
      const wk = root.querySelector(`[data-fs-wkts="${pid}"]`);
      const r = Number(el.value) || 0, k = Number(wk && wk.value) || 0;
      if (el.value === "" && (!wk || wk.value === "") && !perf[pid]) return;   // never touched
      perf[pid] = { runs: Math.max(0, Math.round(r)), wickets: Math.max(0, Math.round(k)) };
    });
    return perf;
  }
  function fillFromDaily(id) {
    const w = weekById(id); if (!w) return;
    if (!w.startDate || !w.endDate) { say("Give the week a From and To date first", "bad"); return; }
    const days = (pool().days || []).filter(d => d.date && d.date >= w.startDate && d.date <= w.endDate);
    if (!days.length) { say("No daily matches are dated in this week", "bad"); return; }
    const sum = {};
    days.forEach(d => Object.entries(d.performance || {}).forEach(([pid, p]) => {
      const cur = sum[pid] || { runs: 0, wickets: 0 };
      cur.runs += Number(p && p.runs) || 0; cur.wickets += Number(p && p.wickets) || 0;
      sum[pid] = cur;
    }));
    const root = document.getElementById("fan-body");
    let n = 0;
    Object.entries(sum).forEach(([pid, p]) => {
      const r = root.querySelector(`[data-fs-runs="${pid}"]`), k = root.querySelector(`[data-fs-wkts="${pid}"]`);
      if (r) { r.value = p.runs; n++; }
      if (k) k.value = p.wickets;
      const pts = root.querySelector(`[data-fs-rowpts="${pid}"]`);
      if (pts) pts.textContent = fmtPts(p.runs + p.wickets * 10);
    });
    say(`Filled ${n} player${n === 1 ? "" : "s"} from ${days.length} daily match${days.length === 1 ? "" : "es"} - check, then save or publish`, "good");
  }
  async function saveScores(publish) {
    const w = weekById(UI.weekId); if (!w) return;
    const perf = readScores(w);
    saving = true;
    try {
      if (!publish) {
        await fs().setDoc(weekRef(w.id), { performance: perf }, { merge: true });
        say("Scores saved - not published yet", "good");
        return;
      }
      if (weekOpen(w) && !confirm("This week hasn't locked - members can still change teams after you publish. Publish anyway?")) return;
      const scored = { ...w, performance: perf };
      // Re-read the teams at publish time: the record is who was in when the
      // editor pressed the button, not whatever a listener happened to hold.
      const ws = await fs().getDocs(wEntryColl(w.id));
      const wList = ws.docs.map(d => normWEntry(d.id, d.data()));
      const standings = ENG.standingsFor(scored, wList);
      await fs().setDoc(weekRef(w.id), {
        performance: perf, standings, hasResults: true,
        publishedAt: Date.now(), publishedBy: (H().user.email || ""),
      }, { merge: true });
      say(`Published - ${standings.length} weekly team${standings.length === 1 ? "" : "s"}`, "good");
    } catch (e) {
      console.error(e); say("Couldn't save the scores", "bad");
    } finally { saving = false; flush(); refresh(true); }
  }
  async function unpublishWeek() {
    const w = weekById(UI.weekId); if (!w) return;
    if (!confirm("Take this week's points off the Weekly leaderboard? The scores are kept.")) return;
    try {
      await fs().setDoc(weekRef(w.id), { hasResults: false, standings: null, publishedAt: 0 }, { merge: true });
      say("Unpublished", "good");
    } catch (e) { console.error(e); say("Couldn't unpublish", "bad"); }
  }

  function weeklyBoardHtml() {
    const rows = ENG.weekSeasonRows(weeks, "standings");
    const last = weeks.filter(w => w.hasResults && Array.isArray(w.standings))
      .sort((a, b) => (b.lockAt || 0) - (a.lockAt || 0))[0];
    return `<div class="fan-board-grid">
      <div class="card"><div class="fan-card-head"><h3>Weekly - season total</h3></div>
        ${boardTableHtml(rows, [{ h: "Wks", v: r => r.days }, { h: "Total", v: r => fmtPts(r.total), strong: true }])}</div>
      ${last ? `<div class="card"><div class="fan-card-head"><h3>${esc(last.label || "Latest week")}</h3></div>
        ${boardTableHtml(last.standings.map(r => ({ ...r, name: r.n })), [{ h: "Points", v: r => fmtPts(r.pts), strong: true }])}</div>` : ""}
    </div>`;
  }

  /* ============================================================
     OVERALL
     ============================================================ */
  function seasonRules() { return { teamSize: cfg.overall.teamSize, maxPerTeam: cfg.overall.maxPerTeam }; }

  function renderOverall() {
    // A tab this viewer can't have (left over from an editor on the same
    // device, say) falls back to My Team. Rendering the team page while the
    // tab still read "season" swallowed every Build / Swap click silently.
    const st = seasonSt();
    if (((UI.oTab === "season" || UI.oTab === "scores") && !canEdit()) || (UI.oTab === "teams" && !canEdit() && st !== "swaps" && st !== "closed")) {
      UI.oTab = "team";
    }
    if (UI.oTab === "season") return seasonFormHtml();
    if (UI.oTab === "scores") return scoresSheetHtml();
    if (UI.oTab === "board") return overallBoardHtml();
    if (UI.oTab === "teams") return overallTeamsHtml();
    if (UI.oView === "build") return overallBuilderHtml();
    if (UI.oView === "swap") return swapBuilderHtml();
    return overallTeamHtml();
  }

  function rulesBlurb() {
    const o = cfg.overall;
    return `One team of <b>${o.teamSize}</b> for the whole season${o.maxPerTeam ? `, at most <b>${o.maxPerTeam}</b> from one team` : ""}, plus a captain (2×) and vice-captain (1.5×). Rebuild it freely until teams lock; after that you get <b>${o.maxSwaps} swaps</b> for the season - each player you bring in uses one. ${o.freeCaptaincy ? "Captain and vice-captain can be changed any time while you still have swaps." : "Captain and vice-captain can be changed when you make a swap."} Once your swaps are used, your team is final.`;
  }

  function myOverallTotal() {
    return oMine ? ENG.overallStandings(oScores, [oMine])[0] : null;
  }

  function overallTeamHtml() {
    const st = seasonSt();
    if (!oMineLoaded) return skel("rows", 4, "Loading your team…");
    let html = `<div class="card fan-intro"><div class="fs-row-between"><h3 style="margin:0">Season team</h3>${seasonChip()}</div>
      <p class="hint">${rulesBlurb()}</p></div>`;
    if (st === "setup") {
      return html + `<div class="card"><p class="hint">${canEdit()
        ? "Set the lock time in <b>Season</b> to open team building."
        : "The season hasn't been opened yet - check back soon."}</p></div>`;
    }
    if (!oMine) {
      if (st === "open") return html + `<div class="card"><p class="hint">You haven't built your season team yet.</p>
        <div class="form-row"><button class="btn btn-red" data-fs-build-overall>Build my team</button></div></div>`;
      return html + `<div class="card"><p class="hint">Teams locked before you entered, so you're not in the Overall contest this season.</p></div>`;
    }
    const left = ENG.swapsLeft(cfg.overall, oMine);
    const total = myOverallTotal();
    const final = st === "closed" || (st === "swaps" && left <= 0);
    html += `<div class="card fan-team-card is-me">
      <div class="fan-tc-head">${avatar(oMine.name, oMine.photo)}
        <span class="fan-tc-name">${esc(oMine.teamName || oMine.name)}${oMine.teamName ? `<span class="frr-sub">${esc(oMine.name)}</span>` : ""}</span>
        <span class="fan-pts">${fmtPts(total ? total.total : 0)} pts</span>
      </div>
      ${teamChipsHtml(oMine, null)}
      <div class="fs-team-foot">
        ${st === "open" ? `<span class="hint">Editable until teams lock.</span><button class="btn btn-dark" data-fs-build-overall>${ic("pencil")}<span>Edit team</span></button>` : ""}
        ${st === "swaps" ? `<span class="fs-swaps-pill ${left ? "" : "is-out"}">${ic("repeat", "sm")} ${left} of ${cfg.overall.maxSwaps} swaps left</span>
          ${left ? `<button class="btn btn-red" data-fs-start-swap>Make a swap</button>` : `<span class="hint">Your team is final.</span>`}` : ""}
        ${st === "closed" ? `<span class="hint">The season is over - this is your final team.</span>` : ""}
      </div></div>`;
    if (!final && st === "swaps" && left) html += `<p class="hint fs-note">A swap counts for matches that start after you make it - never for points already scored.</p>`;
    html += breakdownHtml(oMine) + historyHtml(oMine);
    return html;
  }

  function breakdownHtml(e) {
    const rows = ENG.overallTimeline(oScores, e);
    if (!rows.length) return "";
    return `<div class="card"><h3>Points by update</h3><table class="fan-table"><thead><tr><th>Update</th><th class="num">Points</th></tr></thead>
      <tbody>${rows.slice().reverse().map(r => `<tr><td>${esc(r.label || "Update")} <span class="hint">${esc(whenLabel(r.at))}</span></td><td class="num strong">${r.pts < 0 ? "" : "+"}${fmtPts(r.pts)}</td></tr>`).join("")}</tbody></table></div>`;
  }
  function historyHtml(e) {
    const h = e.history || [];
    if (h.length < 2) return "";
    const items = [];
    for (let i = 1; i < h.length; i++) {
      const a = h[i - 1], b = h[i];
      const outs = a.playerIds.filter(p => b.playerIds.indexOf(p) < 0);
      const ins = b.playerIds.filter(p => a.playerIds.indexOf(p) < 0);
      const bits = [];
      if (outs.length) bits.push(`out <b>${outs.map(p => esc(pname(p))).join(", ")}</b> → in <b>${ins.map(p => esc(pname(p))).join(", ")}</b>`);
      if (b.captainId !== a.captainId) bits.push(`captain → <b>${esc(pname(b.captainId))}</b>`);
      if (b.viceCaptainId !== a.viceCaptainId) bits.push(`vice-captain → <b>${esc(pname(b.viceCaptainId))}</b>`);
      items.push(`<li><span class="fs-hist-when">${esc(whenLabel(b.at))}</span> ${bits.join(" · ")}</li>`);
    }
    return `<div class="card"><h3>Changes</h3><ul class="fs-hist">${items.reverse().join("")}</ul></div>`;
  }

  function overallBuilderHtml() {
    if (seasonSt() !== "open") { UI.oView = "home"; return overallTeamHtml(); }
    if (!B || B.kind !== "overall") openBuilder("overall", seasonRules(), oMine);
    return builderHtml("Season team", seasonChip(), rulesBlurb(), "data-fs-back");
  }
  function swapBuilderHtml() {
    if (seasonSt() !== "swaps" || !oMine || ENG.swapsLeft(cfg.overall, oMine) <= 0) { UI.oView = "home"; return overallTeamHtml(); }
    if (!B || B.kind !== "swap") openBuilder("swap", seasonRules(), oMine);
    const left = ENG.swapsLeft(cfg.overall, oMine);
    const intro = `Tap a player in your team to take him out, then pick his replacement from the pool. Each player you bring in uses a swap - you have <b>${left}</b>. ${cfg.overall.freeCaptaincy ? "You can also move the armbands." : "You can move the armbands in the same swap."} <b>A confirmed swap can't be undone.</b>`;
    return builderHtml("Make a swap", seasonChip(), intro, "data-fs-back");
  }

  async function submitOverall() {
    readTeamName();
    const v = ENG.validateEntry(B.rules, draft, ctx());
    if (!v.ok) { say(v.msg, "bad"); return; }
    if (seasonSt() !== "open") { say("Teams have locked", "bad"); refresh(true); return; }
    const u = me();
    const data = {
      uid: u.uid, name: u.name, photo: u.photo, teamName: draft.teamName || "",
      playerIds: draft.playerIds.slice(), captainId: draft.captainId, viceCaptainId: draft.viceCaptainId,
      swapsUsed: 0,
      history: [{ at: 0, playerIds: draft.playerIds.slice(), captainId: draft.captainId, viceCaptainId: draft.viceCaptainId }],
      createdAt: oMine && oMine.createdAt ? oMine.createdAt : Date.now(),
      updatedAt: fs().serverTimestamp(),
    };
    saving = true; paint();
    try {
      await fs().setDoc(oRef(u.uid), data);
      say(oMine ? "Season team updated" : "Your season team is in", "good");
      closeBuilder(); UI.oView = "home";
    } catch (e) {
      console.error(e);
      say(e && e.code === "permission-denied"
        ? (seasonSt() === "open" ? "The server refused this team - ask an admin to check firestore.rules is published" : "Teams have locked")
        : "Couldn't save your team", "bad");
    } finally { saving = false; flush(); refresh(true); }
  }

  async function submitSwap() {
    await syncClock();
    const v = ENG.validateSwap(cfg.overall, oMine, draft, ctx());
    if (!v.ok) { say(v.msg, "bad"); return; }
    const outs = oMine.playerIds.filter(p => draft.playerIds.indexOf(p) < 0);
    const ins = draft.playerIds.filter(p => oMine.playerIds.indexOf(p) < 0);
    const left = ENG.swapsLeft(cfg.overall, oMine) - v.swaps;
    const lines = [];
    if (ins.length) lines.push(`Out: ${outs.map(pname).join(", ")}\nIn: ${ins.map(pname).join(", ")}`);
    if (draft.captainId !== oMine.captainId) lines.push(`Captain: ${pname(draft.captainId)}`);
    if (draft.viceCaptainId !== oMine.viceCaptainId) lines.push(`Vice-captain: ${pname(draft.viceCaptainId)}`);
    const cost = v.swaps ? `This uses ${v.swaps} swap${v.swaps === 1 ? "" : "s"} - you'll have ${left} left${left ? "" : " and your team will be FINAL"}.` : "This doesn't use a swap.";
    if (!confirm(`${lines.join("\n")}\n\n${cost}\nIt can't be undone. Confirm?`)) return;
    const at = Math.round(now());
    const data = {
      uid: oMine.uid || myUid(), name: oMine.name, photo: oMine.photo, teamName: oMine.teamName || "",
      playerIds: draft.playerIds.slice(), captainId: draft.captainId, viceCaptainId: draft.viceCaptainId,
      swapsUsed: (oMine.swapsUsed || 0) + v.swaps,
      history: [...oMine.history, { at, playerIds: draft.playerIds.slice(), captainId: draft.captainId, viceCaptainId: draft.viceCaptainId }],
      createdAt: oMine.createdAt || 0,
      updatedAt: fs().serverTimestamp(),
    };
    saving = true; paint();
    try {
      await fs().setDoc(oRef(myUid()), data);
      say(v.swaps ? `Swap done - ${left} left` : "Captaincy updated", "good");
      closeBuilder(); UI.oView = "home";
    } catch (e) {
      console.error(e);
      say(e && e.code === "permission-denied"
        ? "The server refused the swap - check your device's date & time, or ask an admin to check firestore.rules"
        : "Couldn't save the swap", "bad");
    } finally { saving = false; flush(); refresh(true); }
  }
  async function withdrawOverall() {
    if (!confirm("Withdraw your season team? You can build a new one until teams lock.")) return;
    try { await fs().deleteDoc(oRef(myUid())); closeBuilder(); UI.oView = "home"; say("Team withdrawn", "good"); refresh(true); }
    catch (e) { console.error(e); say("Couldn't withdraw it", "bad"); }
  }

  function overallBoardHtml() {
    const head = `<div class="card"><div class="fan-card-head"><h3>Overall standings</h3></div>`;
    const last = oScores[oScores.length - 1];
    if (!oScoresLoaded) return head + skel("table", 6, "Loading…") + `</div>`;
    if (!last) return head + `<p class="hint">No points yet - they appear when the first score update is published.</p></div>`;
    const st = seasonSt();
    if (!canEdit() && st !== "swaps" && st !== "closed") return head + `<p class="hint">${ic("lock", "sm")} Standings appear when teams lock.</p></div>`;
    if (!oAllLoaded) return head + skel("table", 6, "Loading teams…") + `</div>`;
    const rows = ENG.overallStandings(oScores, oAll);
    return head + `<p class="hint">Last update: <b>${esc(last.label || "Update")}</b> · ${esc(whenLabel(last.at))}</p>
      ${boardTableHtml(rows, [{ h: "Last update", v: r => (r.last < 0 ? "" : "+") + fmtPts(r.last) }, { h: "Total", v: r => fmtPts(r.total), strong: true }])}</div>`;
  }

  function overallTeamsHtml() {
    const st = seasonSt();
    if (!canEdit() && st !== "swaps" && st !== "closed") return `<div class="card"><p class="hint">${ic("lock", "sm")} Everyone's teams appear when teams lock.</p></div>`;
    if (!oAllLoaded) return skel("cards", 3, "Loading teams…");
    if (!oAll.length) return `<div class="card"><p class="hint">Nobody has built a season team yet.</p></div>`;
    const totals = new Map(ENG.overallStandings(oScores, oAll).map(r => [r.key, r.total]));
    return `<div class="fan-teams-grid">${oAll.slice().sort((a, b) => (totals.get(b.id) || 0) - (totals.get(a.id) || 0)).map(e => `
      <div class="card fan-team-card ${e.id === myUid() ? "is-me" : ""}">
        <div class="fan-tc-head">${avatar(e.name, e.photo)}
          <span class="fan-tc-name">${esc(e.name)}${e.teamName ? `<span class="frr-sub">${esc(e.teamName)}</span>` : ""}</span>
          <span class="fan-pts">${fmtPts(totals.get(e.id) || 0)} pts</span>
        </div>${teamChipsHtml(e, null)}
        <div class="fs-team-foot"><span class="fs-swaps-pill ${ENG.swapsLeft(cfg.overall, e) ? "" : "is-out"}">${ic("repeat", "sm")} ${e.swapsUsed || 0}/${cfg.overall.maxSwaps} swaps used</span>
          ${canEdit() ? `<button class="icon-btn del" data-fs-del-oentry="${e.id}" title="Remove this team" aria-label="Remove this team">${ic("trash-2")}</button>` : ""}</div>
      </div>`).join("")}</div>`;
  }

  /* ---- Overall scores (editors) ----
     The sheet holds SEASON TOTALS, exactly as the stats sheet shows them. Each
     publish adds an update doc; the engine scores what changed since the last
     one. Publishing never touches anyone's team. */
  function latestTotals() {
    const out = {};
    oScores.forEach(u => Object.assign(out, u.totals));
    return out;
  }
  const seasonPts = v => (Number(v && v.runs) || 0) + (Number(v && v.wickets) || 0) * 10;
  const signed = n => (n > 0 ? "+" : "") + fmtPts(n);
  const blankDraft = () => ({ label: null, teamsAt: null, source: "manual", baseline: false, vals: {} });
  // Until the editor says otherwise, an update's gains are scored with the
  // teams as they were when the previous update went out (or at the lock).
  function defaultTeamsAt() {
    const last = oScores[oScores.length - 1];
    return last ? last.at : (cfg.overall.lockAt || 0);
  }

  function scoresSheetHtml() {
    if (!oScoresLoaded) return skel("table", 6, "Loading scores…");
    const base = latestTotals();
    const inPool = new Set(pool().players.map(p => p.id));
    const orphans = Object.keys(base).filter(pid => !inPool.has(pid));
    const d = oDraft || blankDraft();
    let html = `<div class="card fan-intro"><h3>Season scores</h3>
      <p class="hint">Enter every player's <b>season totals so far</b> - runs and wickets exactly as the stats sheet shows them - then publish. Each update scores what changed since the previous one: 1 per run, 10 per wicket, captain 2×, vice-captain 1.5×. Only Overall uses this sheet - Daily and Weekly keep their own.</p>
      <div class="form-row"><button class="btn btn-dark btn-mini" data-fo-fill>${ic("download", "sm")}<span>Fill from stats sheet</span></button>
        ${oDraft ? `<button class="btn btn-dark btn-mini" data-fo-discard>${ic("rotate-ccw", "sm")}<span>Discard changes</span></button>` : ""}</div></div>`;
    html += fillReportHtml();
    html += `<div class="card"><h3>Runs &amp; wickets - season totals</h3><div class="fan-results">`;
    pool().teams.forEach(t => {
      const ps = pool().players.filter(p => p.teamId === t.id);
      if (!ps.length) return;
      html += `<div class="fan-results-team"><div class="fan-pool-team-name">${esc(t.name)}</div>${ps.map(p => oScoreRowHtml(p.id, p.name, base)).join("")}</div>`;
    });
    if (orphans.length) {
      html += `<div class="fan-results-team"><div class="fan-pool-team-name">No longer in the pool</div>${orphans.map(pid => oScoreRowHtml(pid, pname(pid), base)).join("")}</div>`;
    }
    html += `</div>
      ${oScores.length ? "" : `<label class="fan-check"><input type="checkbox" id="foBaseline" ${d.baseline ? "checked" : ""}/>
        <span><b>Starting point only</b> - record these totals as the baseline and score nothing. Tick this only if the sheet already includes matches played <i>before</i> Overall teams locked.</span></label>`}
      <div class="fan-publish-bar">
        <label class="fo-label">Update name<input id="foLabel" value="${esc(d.label != null ? d.label : `Update ${oScores.length + 1}`)}" placeholder="e.g. After match 12"/></label>
        <label class="fo-label">Teams as they stood at<input type="datetime-local" id="foTeamsAt" value="${esc(d.teamsAt != null ? d.teamsAt : toLocalInput(defaultTeamsAt()))}"/></label>
        <button class="btn btn-red" data-fo-publish>${ic("megaphone")}<span>Publish update</span></button>
      </div>
      <p class="hint">Set <b>Teams as they stood at</b> to when the first match in this update started: swaps made before then count for these runs &amp; wickets, swaps made after don't. Left as it is, it's when the last update went out.</p></div>`;
    return html + updatesListHtml();
  }
  function oScoreRowHtml(pid, name, base) {
    const b = base[pid] || null;
    const typed = oDraft && oDraft.vals[pid];
    const runs = typed ? typed.runs : (b ? String(b.runs) : "");
    const wkts = typed ? typed.wickets : (b ? String(b.wickets) : "");
    return `<div class="fan-res-row"><span class="frr-name">${esc(name)}</span>
      <div class="frr-inputs">
        <input type="number" min="0" inputmode="numeric" data-fo-runs="${pid}" value="${esc(runs)}" placeholder="runs"/>
        <input type="number" min="0" inputmode="numeric" data-fo-wkts="${pid}" value="${esc(wkts)}" placeholder="wkts"/>
        <span class="frr-pts fo-pts" data-fo-rowpts="${pid}">${rowPtsHtml(runs, wkts, b)}</span>
      </div></div>`;
  }
  /* The player's season points, and what this update adds for him. */
  function rowPtsHtml(runs, wkts, b) {
    const pts = (Number(runs) || 0) + (Number(wkts) || 0) * 10;
    const gain = pts - seasonPts(b);
    return `${fmtPts(pts)}${gain ? `<span class="fo-gain ${gain < 0 ? "is-neg" : ""}">${signed(gain)}</span>` : ""}`;
  }
  function fillReportHtml() {
    if (!oFill) return "";
    const list = (title, names) => names.length
      ? `<details class="fo-miss"><summary>${title} (${names.length})</summary><p class="hint">${names.map(esc).join(", ")}</p></details>` : "";
    return `<div class="card fo-fill"><p class="hint">Filled <b>${oFill.matched}</b> player${oFill.matched === 1 ? "" : "s"} from the stats sheet. Check the numbers, then publish.</p>
      ${list("In the pool but not on the sheet - type these in", oFill.missing)}
      ${list("On the sheet but not in the pool", oFill.extra)}</div>`;
  }
  function updatesListHtml() {
    if (!oScores.length) return `<div class="card"><h3>Published updates</h3><p class="hint">None yet. The first update counts every run and wicket on the sheet.</p></div>`;
    const lastId = oScores[oScores.length - 1].id;
    return `<div class="card"><h3>Published updates</h3><ul class="fs-hist">${oScores.slice().reverse().map(u => `
      <li class="fo-upd"><span><span class="fs-hist-when">${esc(whenLabel(u.at))}</span> <b>${esc(u.label || "Update")}</b>
        <span class="hint">· ${u.baseline ? "starting point" : u.source === "sheet" ? "from stats sheet" : "typed in"}${u.changed ? ` · ${u.changed} player${u.changed === 1 ? "" : "s"} changed` : ""}${u.teamsAt && !u.baseline ? ` · teams as at ${esc(whenLabel(u.teamsAt))}` : ""}</span></span>
        ${u.id === lastId ? `<button class="icon-btn del" data-fo-del="${u.id}" title="Remove this update" aria-label="Remove this update">${ic("trash-2")}</button>` : ""}</li>`).join("")}</ul></div>`;
  }

  /* The viewed tournament's stats sheet, as series.js resolves it: HCCL
     seasons from the season archive, everything else from its imported sheet
     (falling back to a bundled one). -> [{ name, team, runs, wickets }] */
  async function statsSheetPlayers() {
    const S = window.HCCLSeries, A = window.HCCLSeasonArchive;
    if (!A) return null;
    const m = (S && S.list ? S.list() : []).find(x => x.id === tid)
      || (tid === LEGACY_TID ? { id: tid, legacy: true, season: 6 } : { id: tid });
    let rows = null;
    if (m.legacy || m.archive === "hccl") {
      const no = m.season || (m.legacy ? 6 : null);
      rows = no ? A.seasonRows(no) : null;
    } else {
      let csv = "";
      try {
        const snap = await fs().getDoc(fs().doc(db(), "tournaments", tid, "stats", "sheet"));
        const d = snap.exists() ? snap.data() : null;
        csv = (d && typeof d.csv === "string") ? d.csv : "";
      } catch (e) { console.warn("stats sheet:", e && e.code); }
      if (!csv.trim()) csv = A.tournamentCsv(tid, m.name) || "";
      rows = csv.trim() ? A.rowsFromCsv(csv) : null;
    }
    return rows && rows.length ? A.playersFromRows(rows) : null;
  }
  const nameKey = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const sheetNum = v => Math.max(0, Math.round(parseFloat(v) || 0));

  /* Fills the inputs only - nothing is saved until Publish. Pool players are
     matched to sheet rows by name; the team breaks a tie between namesakes. */
  async function fillFromStats() {
    let list = null;
    try { list = await statsSheetPlayers(); } catch (e) { console.warn(e); }
    if (!list || !list.length) { say("No stats sheet found for this tournament - import one on its Stats page first", "bad"); return; }
    const byName = new Map();
    list.forEach((s, i) => {
      const k = nameKey(s.name); if (!k) return;
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(i);
    });
    const used = new Set(), missing = [], vals = {};
    pool().players.forEach(p => {
      const hits = byName.get(nameKey(p.name)) || [];
      const i = hits.length === 1 ? hits[0] : hits.find(j => nameKey(list[j].team) === nameKey(teamName(p.teamId)));
      if (i == null) { missing.push(p.name); return; }
      used.add(i);
      vals[p.id] = { runs: String(sheetNum(list[i].runs)), wickets: String(sheetNum(list[i].wickets)) };
    });
    const extra = list.filter((s, i) => !used.has(i) && nameKey(s.name)).map(s => s.name + (s.team ? ` (${s.team})` : ""));
    const d = oDraft || blankDraft();
    oDraft = { ...d, source: "sheet", vals: { ...d.vals, ...vals } };
    oFill = { matched: Object.keys(vals).length, missing, extra };
    say(`Filled ${oFill.matched} player${oFill.matched === 1 ? "" : "s"} from the stats sheet - check, then publish`, oFill.matched ? "good" : "bad");
    refresh(true);
  }

  async function publishScores() {
    if (!canEdit()) return;
    const base = latestTotals();
    const totals = { ...base };
    let changed = 0;
    // A blank box keeps the player's previous figure; it never zeroes him.
    const pick = (s, prev) => (s === "" || s == null) ? (Number(prev) || 0) : Math.max(0, Math.round(Number(s) || 0));
    Object.entries((oDraft && oDraft.vals) || {}).forEach(([pid, v]) => {
      const b = base[pid];
      if (!b && (v.runs === "" || v.runs == null) && (v.wickets === "" || v.wickets == null)) return;   // never touched
      const next = { runs: pick(v.runs, b && b.runs), wickets: pick(v.wickets, b && b.wickets) };
      if (next.runs !== ((b && b.runs) || 0) || next.wickets !== ((b && b.wickets) || 0)) changed++;
      totals[pid] = next;
    });
    if (!changed) { say("Nothing changed since the last update", "bad"); return; }
    const labelEl = document.getElementById("foLabel");
    const label = ((labelEl && labelEl.value) || "").trim().slice(0, 60) || `Update ${oScores.length + 1}`;
    const baselineEl = document.getElementById("foBaseline");
    const baseline = !oScores.length && !!(baselineEl && baselineEl.checked);
    // The input only has minute precision: left at its default, keep the exact time.
    const def = defaultTeamsAt(), taEl = document.getElementById("foTeamsAt");
    const taVal = taEl ? taEl.value : "";
    const teamsAt = (!taVal || taVal === toLocalInput(def)) ? def : fromLocalInput(taVal);
    await syncClock();
    if (teamsAt > now()) { say("“Teams as they stood at” can't be in the future", "bad"); return; }
    const st = seasonSt();
    const warn = (st === "setup" || st === "open") && !baseline
      ? "\n\n⚠ Teams haven't locked yet - members can still rebuild with these scores in view." : "";
    const what = baseline ? "It records the starting totals and scores nothing." : "Everyone's Overall points update straight away.";
    if (!confirm(`Publish "${label}"? ${changed} player${changed === 1 ? "" : "s"} changed. ${what}${warn}`)) return;
    const id = "u" + Date.now().toString(36);
    const data = {
      at: Math.round(now()), label, source: (oDraft && oDraft.source) || "manual",
      totals, changed, createdBy: (H().user.email || ""), createdAt: Date.now(),
    };
    if (teamsAt > 0) data.teamsAt = Math.round(teamsAt);
    if (baseline) data.baseline = true;
    saving = true;
    try {
      await fs().setDoc(scoreRef(id), data);
      oDraft = null; oFill = null;
      say(baseline ? "Starting point recorded" : `Published - ${changed} player${changed === 1 ? "" : "s"} updated`, "good");
    } catch (e) {
      console.error(e);
      say(e && e.code === "permission-denied" ? "The server refused it - only admins and moderators can publish scores" : "Couldn't publish the update", "bad");
    } finally { saving = false; flush(); refresh(true); }
  }
  async function deleteScoreUpdate(id) {
    const u = oScores[oScores.length - 1];
    if (!u || u.id !== id) { say("Only the latest update can be removed", "bad"); return; }
    if (!confirm(`Remove "${u.label || "this update"}"? Its points come off everyone's Overall total. Teams aren't affected.`)) return;
    try { await fs().deleteDoc(scoreRef(id)); say("Update removed", "good"); }
    catch (e) { console.error(e); say("Couldn't remove it", "bad"); }
  }

  /* ---- season settings (editors) ---- */
  function seasonFormHtml() {
    const o = cfg.overall, st = seasonSt();
    const frozen = oAllLoaded && oAll.length > 0;
    return `<div class="card fan-form">
      <div class="fs-row-between"><h3 style="margin:0">Season settings</h3>${seasonChip()}</div>
      ${frozen ? `<div class="fan-form-warn">${ic("circle-alert")} ${oAll.length} season team${oAll.length === 1 ? " exists" : "s exist"}, so the team size is fixed.</div>` : ""}
      <div class="form-row">
        <label style="flex:1 1 150px">Players per team<input type="number" min="1" max="15" id="fsOSize" value="${o.teamSize}" ${frozen ? "disabled" : ""}/></label>
        <label style="flex:1 1 150px">Swaps per season<input type="number" min="0" max="20" id="fsOSwaps" value="${o.maxSwaps}"/></label>
        <label style="flex:1 1 190px">Max from one team <span class="hint">(blank = no limit)</span><input type="number" min="1" max="15" id="fsOCap" value="${o.maxPerTeam || ""}" placeholder="no limit"/></label>
      </div>
      <label>Teams lock at<input type="datetime-local" id="fsOLock" value="${toLocalInput(o.lockAt)}"/></label>
      <p class="hint">Until then members build and rebuild freely. From then on, swaps only. Points come from <b>Scores</b> - publish the first update once teams have locked.</p>
      <label class="fan-check"><input type="checkbox" id="fsOFreeCap" ${o.freeCaptaincy ? "checked" : ""}/>
        <span><b>Free captaincy changes</b> - let members move captain / vice-captain without spending a swap (until their swaps run out). Off: the armbands can only move in the same submission as a swap.</span></label>
      <div class="form-row">
        <button class="btn btn-red" data-fs-save-season>Save settings</button>
        ${st === "open" ? `<button class="btn btn-dark" data-fs-lock-season>${ic("lock")}<span>Lock teams now</span></button>` : ""}
        ${st === "swaps" ? `<button class="btn btn-dark" data-fs-close-season>${ic("flag")}<span>End season</span></button>` : ""}
        ${st === "closed" ? `<button class="btn btn-dark" data-fs-reopen-season>${ic("undo-2")}<span>Reopen swaps</span></button>` : ""}
      </div>
    </div>`;
  }
  async function saveSeason() {
    const val = id => { const el = document.getElementById(id); return el ? el.value : ""; };
    const o = { ...cfg.overall };
    if (!(oAllLoaded && oAll.length)) o.teamSize = Math.max(1, Math.min(15, parseInt(val("fsOSize"), 10) || ENG.DEFAULT_TEAM_SIZE));
    o.maxSwaps = Math.max(0, Math.min(20, parseInt(val("fsOSwaps"), 10) || 0));
    const cap = val("fsOCap");
    o.maxPerTeam = cap === "" ? 0 : Math.max(1, Math.min(15, parseInt(cap, 10) || 0));
    o.lockAt = fromLocalInput(val("fsOLock"));
    const fc = document.getElementById("fsOFreeCap");
    o.freeCaptaincy = !!(fc && fc.checked);
    if (!o.lockAt) { say("Set when teams lock", "bad"); return; }
    if (o.maxPerTeam && o.maxPerTeam * pool().teams.length < o.teamSize) { say("That per-team cap makes a full team impossible", "bad"); return; }
    await writeSeason(o, "Season settings saved");
  }
  async function writeSeason(o, msg) {
    try { await fs().setDoc(cfgRef(), { overall: o }, { merge: true }); say(msg, "good"); }
    catch (e) { console.error(e); say("Couldn't save - check firestore.rules is published", "bad"); }
  }
  async function lockSeasonNow() {
    if (!confirm("Lock season teams now? From this moment members can only make swaps.")) return;
    await writeSeason({ ...cfg.overall, lockAt: now() }, "Teams locked - swaps only from now");
  }
  async function closeSeason(closed) {
    if (closed && !confirm("End the season? No more swaps for anyone.")) return;
    await writeSeason({ ...cfg.overall, closed: !!closed }, closed ? "Season ended" : "Swaps reopened");
  }
  async function deleteOverallEntry(id) {
    const e = oAll.find(x => x.id === id);
    if (!confirm(`Remove ${e ? e.name : "this"}'s season team? This can't be undone.`)) return;
    try { await fs().deleteDoc(oRef(id)); say("Team removed", "good"); }
    catch (er) { console.error(er); say("Couldn't remove it", "bad"); }
  }

  /* ============================================================
     TICKER: countdowns + state crossings (week / season lock)
     ============================================================ */
  let tickTimer = null, lastSig = "";
  function sig() {
    const t = now();
    return seasonSt() + "|" + weeks.map(w => w.id + ":" + (w.lockAt && t >= w.lockAt ? 1 : 0)).join(",");
  }
  function tick() {
    if (!mounted) return;
    document.querySelectorAll("[data-fs-countdown]").forEach(el => {
      const at = Number(el.getAttribute("data-fs-countdown")) || 0;
      const left = at - now();
      el.textContent = (el.textContent.indexOf("teams lock") >= 0 ? "teams lock in " : "locks in ") + ENG.fmtCountdown(left);
      el.classList.toggle("is-closing", left > 0 && left < 600000);
    });
    const s = sig();
    if (lastSig && s !== lastSig) { syncOverallAll(); refresh(true); }
    lastSig = s;
  }
  function startTicker() { if (!tickTimer) tickTimer = setInterval(tick, 1000); lastSig = sig(); }

  /* ============================================================
     EVENTS
     ============================================================ */
  function inFantasy(t) { const v = document.getElementById("view-fantasy"); return v && v.contains(t); }
  function onClick(e) {
    const t = e.target;
    if (!t.closest || !inFantasy(t)) return;
    let m;
    // --- tabs ---
    if ((m = t.closest("[data-fs-wtab]"))) { UI.wTab = m.getAttribute("data-fs-wtab"); UI.wView = "list"; UI.weekId = null; closeBuilder(); return refresh(true); }
    if ((m = t.closest("[data-fs-otab]"))) { UI.oTab = m.getAttribute("data-fs-otab"); UI.oView = "home"; closeBuilder(); return refresh(true); }
    if ((m = t.closest("[data-fs-mode-on]"))) return toggleMode(m.getAttribute("data-fs-mode-on"), true);
    // --- builder ---
    if ((m = t.closest("[data-fs-pick]"))) return togglePick(m.getAttribute("data-fs-pick"));
    if ((m = t.closest("[data-fs-unpick]"))) return togglePick(m.getAttribute("data-fs-unpick"));
    if ((m = t.closest("[data-fs-assign]"))) { const r = m.getAttribute("data-fs-assign"); assign = assign === r ? null : r; return paint(); }
    if (t.closest("[data-fs-submit]")) {
      if (!B) return;
      if (B.kind === "weekly") return submitWeekly();
      if (B.kind === "overall") return submitOverall();
      if (B.kind === "swap") return submitSwap();
    }
    if (t.closest("[data-fs-back]")) {
      if (draft && draft.dirty && !confirm("Leave without saving your changes?")) return;
      closeBuilder(); UI.wView = "list"; UI.weekId = null; UI.wForm = null; UI.oView = "home";
      return refresh(true);
    }
    // --- weekly ---
    if ((m = t.closest("[data-fs-open-week]"))) {
      UI.weekId = m.getAttribute("data-fs-open-week");
      UI.wView = m.getAttribute("data-fs-goto") || "teams";
      closeBuilder(); return refresh(true);
    }
    if (t.closest("[data-fs-new-week]")) return openWeekForm(null);
    if ((m = t.closest("[data-fs-edit-week]"))) return openWeekForm(m.getAttribute("data-fs-edit-week"));
    if (t.closest("[data-fs-save-week]")) return saveWeekForm();
    if ((m = t.closest("[data-fs-lock-week]"))) return lockWeekNow(m.getAttribute("data-fs-lock-week"));
    if ((m = t.closest("[data-fs-del-week]"))) return deleteWeek(m.getAttribute("data-fs-del-week"));
    if (t.closest("[data-fs-withdraw-week]")) return withdrawWeekly();
    if ((m = t.closest("[data-fs-del-wentry]"))) return withdrawWeekly(m.getAttribute("data-fs-del-wentry"));
    if ((m = t.closest("[data-fs-fill-daily]"))) return fillFromDaily(m.getAttribute("data-fs-fill-daily"));
    if (t.closest("[data-fs-save-scores]")) return saveScores(false);
    if (t.closest("[data-fs-publish]")) return saveScores(true);
    if (t.closest("[data-fs-unpublish]")) return unpublishWeek();
    // --- overall ---
    if (t.closest("[data-fs-build-overall]")) { UI.oView = "build"; closeBuilder(); return refresh(true); }
    if (t.closest("[data-fs-start-swap]")) { UI.oView = "swap"; closeBuilder(); return refresh(true); }
    if (t.closest("[data-fs-withdraw-overall]")) return withdrawOverall();
    if ((m = t.closest("[data-fs-del-oentry]"))) return deleteOverallEntry(m.getAttribute("data-fs-del-oentry"));
    if (t.closest("[data-fs-save-season]")) return saveSeason();
    if (t.closest("[data-fs-lock-season]")) return lockSeasonNow();
    if (t.closest("[data-fs-close-season]")) return closeSeason(true);
    if (t.closest("[data-fs-reopen-season]")) return closeSeason(false);
    if (t.closest("[data-fo-fill]")) return fillFromStats();
    if (t.closest("[data-fo-discard]")) { oDraft = null; oFill = null; return refresh(true); }
    if (t.closest("[data-fo-publish]")) return publishScores();
    if ((m = t.closest("[data-fo-del]"))) return deleteScoreUpdate(m.getAttribute("data-fo-del"));
  }
  function onChange(e) {
    const t = e.target;
    if (t && t.matches && t.matches("[data-fs-mode-toggle]")) toggleMode(t.getAttribute("data-fs-mode-toggle"), t.checked);
    if (t && t.id === "foBaseline") { oDraft = oDraft || blankDraft(); oDraft.baseline = t.checked; }
  }
  function onInput(e) {
    const t = e.target;
    if (!t || !t.matches) return;
    if (t.matches("[data-fs-runs], [data-fs-wkts]")) {
      const pid = t.getAttribute("data-fs-runs") || t.getAttribute("data-fs-wkts");
      const root = document.getElementById("fan-body");
      const r = Number((root.querySelector(`[data-fs-runs="${pid}"]`) || {}).value) || 0;
      const k = Number((root.querySelector(`[data-fs-wkts="${pid}"]`) || {}).value) || 0;
      const out = root.querySelector(`[data-fs-rowpts="${pid}"]`);
      if (out) out.textContent = fmtPts(r + k * 10);
    }
    // Overall sheet: keep what's typed so a snapshot re-render can't wipe it.
    if (t.matches("[data-fo-runs], [data-fo-wkts]")) {
      const pid = t.getAttribute("data-fo-runs") || t.getAttribute("data-fo-wkts");
      const root = document.getElementById("fan-body");
      const r = root.querySelector(`[data-fo-runs="${pid}"]`), k = root.querySelector(`[data-fo-wkts="${pid}"]`);
      oDraft = oDraft || blankDraft();
      oDraft.vals[pid] = { runs: r ? r.value : "", wickets: k ? k.value : "" };
      const out = root.querySelector(`[data-fo-rowpts="${pid}"]`);
      if (out) out.innerHTML = rowPtsHtml(oDraft.vals[pid].runs, oDraft.vals[pid].wickets, latestTotals()[pid]);
    }
    if (t.id === "foLabel") { oDraft = oDraft || blankDraft(); oDraft.label = t.value; }
    if (t.id === "foTeamsAt") { oDraft = oDraft || blankDraft(); oDraft.teamsAt = t.value; }
    if (t.id === "fsTeamName" && draft) { draft.teamName = t.value; draft.dirty = true; }
  }

  function onAuth() { if (cloudOn()) start(); else { stop(); refresh(true); } }

  function init() {
    document.addEventListener("click", onClick);
    document.addEventListener("change", onChange);
    document.addEventListener("input", onInput);
    document.addEventListener("focusout", () => setTimeout(flush, 0));
    if (window.HCCL && typeof window.HCCL.onChange === "function") window.HCCL.onChange(onAuth);
    // Tournament switched: drop this tournament's listeners and resubscribe.
    if (window.HCCLSeries && typeof window.HCCLSeries.onChange === "function") {
      window.HCCLSeries.onChange(() => { if (cloudOn()) start(); });
    }
    onAuth();
  }

  window.HCCLFantasySeason = {
    MODES, visibleModes, enabledModes, savedMode, rememberMode,
    modeBarHtml, subnavHtml, modesCardHtml, render, unmount,
    isCloud: cloudOn,
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
