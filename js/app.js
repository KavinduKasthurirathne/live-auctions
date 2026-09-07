/* ============================================================
   HCCL Live Auction
   Single-screen auction tool. Data stays in this browser
   (localStorage). Use Setup → Export for permanent backups.
   ============================================================ */

/* ---------- tiny DOM helpers ---------- */
const $  = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

/* ---------- state ---------- */
const KEY = "hccl_auction_v1";

function defaultState() {
  return {
    settings: {
      seasonName: "HCCL",
      seasonNumber: 6,
      leagueLogo: "",
      currency: "Cr",
      defaultPurse: 100,
      squadSize: 5,      // players per team; a team may override via team.maxPlayers
      bidIncrement: 1,
      // Right to Match: a team may reclaim a player who was on its roster last
      // season by matching the winning bid. rtmCards is per team (IPL: 1).
      rtmEnabled: true,
      rtmCards: 1,
      prevTournamentId: "", // which tournament counts as "last season"
    },
    teams: [],   // { id, name, logo, purse, maxPlayers }
    players: [], // { id, name, role, basePrice, photo, status, soldTo, soldPrice, formerTeamId, rtmBy }
    // rtm: null, or the live Right-to-Match handshake (see the RTM section below).
    // It rides state.auction, so the existing `live` doc broadcasts it to every device.
    auction: { currentPlayerId: null, currentBid: 0, currentBidderId: null, soldStage: 0, bidLog: [], lastResult: null, rtm: null },
    lastAction: null, // { type, playerId }for Undo
  };
}

function normalize(s) {
  const d = defaultState();
  s = s || {};
  s.settings = { ...d.settings, ...(s.settings || {}) };
  s.teams = Array.isArray(s.teams) ? s.teams : [];
  s.players = Array.isArray(s.players) ? s.players : [];
  s.players.forEach(p => {
    if (!p.status) p.status = "available";
    if (p.soldTo === undefined) p.soldTo = null;
    if (p.soldPrice === undefined) p.soldPrice = null;
    if (p.role === undefined) p.role = "";
    if (p.photo === undefined) p.photo = "";
    if (p.retained === undefined) p.retained = false;
    // RTM: which team held him last season ("" / null = unset, "none" = explicitly
    // nobody), and which team spent an RTM card to sign him.
    if (p.formerTeamId === undefined) p.formerTeamId = null;
    if (p.rtmBy === undefined) p.rtmBy = null;
  });
  s.auction = { ...d.auction, ...(s.auction || {}) };
  if (!Array.isArray(s.auction.bidLog)) s.auction.bidLog = [];
  if (s.lastAction === undefined) s.lastAction = null;
  return s;
}

let state = normalize(load());

function load() {
  try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; }
  catch (e) { return null; }
}
function save() {
  // Cloud mode: Firestore is the source of truth; don't touch the local backup
  // (KEY) so a one-time "upload to cloud" can still recover this device's data.
  if (auUsingFirestore) { if (auCanEdit()) auctionSyncDiff(); return; }
  // The local backup only ever mirrors the legacy tournament - other
  // tournaments are cloud-only, so an offline reload never shows their data.
  if (window.HCCLSeries && !window.HCCLSeries.isLegacy()) return;
  try { localStorage.setItem(KEY, JSON.stringify(state)); }
  catch (e) { toast("Storage full - export a backup and use smaller images", "bad"); }
}

/* ============================================================
   SHARED SYNC HELPERS (window.HCCLSync)
   Used by this file, fantasy.js and fixtures.js - app.js loads first
   (see index.html), same as window.HCCLAuction / window.HCCLSeries.

   The key fact these exist for: onSnapshot's error callback is TERMINAL - the
   listener is dead once it fires. So a transient error (a tunnel, a flaky
   hotspot, a backgrounded phone) has to be answered with an explicit
   resubscribe. Tearing the connection down and never retrying - which is what
   this app used to do - turns a two-second blip into "this device only" until
   the user reloads.
   ============================================================ */
window.HCCLSync = (function () {
  // Terminal: retrying can't help, the setup itself is wrong. Everything else
  // (unavailable, deadline-exceeded, resource-exhausted, internal, cancelled,
  // aborted, and anything unrecognised) is treated as transient and retried.
  const TERMINAL = new Set(["permission-denied", "not-found", "unauthenticated"]);
  const isTerminal = err => TERMINAL.has(err && err.code);
  // 2s, 4s, 8s, 16s, then every 30s.
  const backoff = attempt => Math.min(30000, 2000 * Math.pow(2, Math.max(0, attempt)));

  // Fire cb when the network or the tab comes back. Both matter: a phone that
  // was backgrounded mid-load stalls its requests while timers keep running.
  const cbs = new Set();
  function wake() { cbs.forEach(cb => { try { cb(); } catch (e) { console.error(e); } }); }
  window.addEventListener("online", wake);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) wake(); });

  return {
    isTerminal, backoff,
    onReconnect(cb) { cbs.add(cb); return () => cbs.delete(cb); },
  };
})();

/* ============================================================
   FIRESTORE REAL-TIME SYNC (Phase D)
   When Firebase is configured AND signed in, auction data lives in Firestore:
     auction/league/teams/{id}, auction/league/players/{id},
     auction/league/state/settings, auction/league/state/live.
   onSnapshot mirrors it into `state`; local edits (save) push a minimal diff.
   With no Firebase (or if unreachable) we stay on localStorage, as before.
   ============================================================ */
const AU_COLLS = ["teams", "players"];
// Readiness is gated on the CORE text docs only. The image collections are
// base64 blobs (one doc per player/team) and can run to several MB on a full
// roster - waiting for them before declaring the connection healthy is what
// used to trip the "Live sync unavailable" fallback on mobile data, even though
// the text data had already arrived. They now stream in afterwards.
const AU_CORE = ["teams", "players", "settings", "live"];
let auUsingFirestore = false;
let auFsReady = false;
const auFsLoaded = new Set();
const auMirror = { teams: [], players: [], settings: null, live: null };
const auUnsubs = [];
let auPendingRender = false;
let auSyncing = false, auSyncAgain = false;
let auFellBack = false;
let auGen = 0;      // subscription generation (bumped on every (re)subscribe)
let auTid = null;   // tournament id the current subscriptions belong to
let auImgStarted = false;  // lazy image listeners attached for this generation
let auImgLoaded = new Set();
let auRetries = 0;         // consecutive transient failures (drives the backoff)
let auSlow = false;        // watchdog tripped: still connecting, NOT fallen back

function auCanEdit() { const H = window.HCCL; return !H || !H.configured || H.canEdit(); }
const auApi = () => window.HCCL && window.HCCL.fs;
const auDb  = () => window.HCCL && window.HCCL.db;
// Tournament namespace (js/series.js): [] for the legacy tournament (original
// roots), ["tournaments", tid] for every other tournament.
const auPrefix = () => (window.HCCLSeries ? window.HCCLSeries.prefix() : []);
const auCollRef  = coll     => auApi().collection(auDb(), ...auPrefix(), "auction", "league", coll);
const auItemRef  = (coll, id) => auApi().doc(auDb(), ...auPrefix(), "auction", "league", coll, id);
const auStateRef = name     => auApi().doc(auDb(), ...auPrefix(), "auction", "league", "state", name);
function auStrip(o) { const c = Object.assign({}, o); delete c.id; return c; }
function auClone(x) { return JSON.parse(JSON.stringify(x)); }

// Player photos & team logos live in their OWN one-image-per-doc collections
// (auction/league/playerPhotos|teamLogos) so the heavy base64 blobs don't bloat the
// frequently-synced text docs (which used to blow past Firestore's per-write size cap
// and silently fail). These maps mirror the cloud images, keyed by player/team id.
const auImg = { playerPhotos: new Map(), teamLogos: new Map() };
function auStripPlayer(p) { const c = auStrip(p); delete c.photo; return c; } // text-only doc
function auStripTeam(t)   { const c = auStrip(t); delete c.logo;  return c; }
// Re-apply the mirrored images onto state whenever either the text docs OR the image
// docs change (the text snapshots rebuild the arrays and would otherwise drop photos).
function auApplyImages() {
  state.players.forEach(p => { p.photo = auImg.playerPhotos.get(p.id) || ""; });
  state.teams.forEach(t => { t.logo = auImg.teamLogos.get(t.id) || ""; });
  publishTeamLogos();
}

// --- Global team-logo registry (for the standalone Rankings board) ---
// The Rankings page is not tied to a tournament, but its crests come from team
// logos. Reading them from the currently-viewed tournament's state.teams made
// them vanish on every tournament switch. Instead we mirror each team's logo,
// keyed by (normalized) team NAME, into ranking/logos/teams/{key} - one doc per
// team (base64 logos would blow a single doc's size cap). Editors write, everyone
// reads (firestore.rules: ranking/**). ranking.js reads this, decoupled from the
// viewed tournament, so logos persist across switches / "set default".
const auLogoRegCache = new Map();      // nameKey -> logo we last published (skip no-op writes)
function auTeamNameKey(name) { return String(name || "").trim().toLowerCase().replace(/[^\w -]/g, "").slice(0, 120); }
function publishTeamLogos() {
  const H = window.HCCL, fs = auApi();
  if (!H || !H.configured || !H.user || !auDb() || !fs || !fs.doc || !fs.setDoc || !auCanEdit()) return;
  state.teams.forEach(t => {
    const key = auTeamNameKey(t.name);
    const logo = t.logo || "";
    if (!key || !logo || auLogoRegCache.get(key) === logo) return; // nothing new to publish
    auLogoRegCache.set(key, logo);
    try { fs.setDoc(fs.doc(auDb(), "ranking", "logos", "teams", key), { name: t.name, logo }); }
    catch (e) { /* registry is a convenience mirror - never block the auction on it */ }
  });
}
// Build set/delete ops for an image collection by comparing current images to the mirror.
// `allowDeletes` is false until this collection's listener has delivered once:
// deletions are inferred from the mirror, and an empty mirror during the lazy
// image load would otherwise read as "every photo was removed". Set-ops stay
// unconditional so a photo uploaded during that window is never dropped.
function auDiffImages(coll, items, getImg, ops, allowDeletes) {
  const map = auImg[coll];
  const curIds = new Set(items.map(x => x.id));
  items.forEach(x => {
    const img = getImg(x) || "";
    if (img && map.get(x.id) !== img) ops.push({ t: "set", ref: auItemRef(coll, x.id), data: { data: img } });
    else if (!img && map.has(x.id) && allowDeletes) ops.push({ t: "del", ref: auItemRef(coll, x.id) });
  });
  if (allowDeletes)
    map.forEach((_, id) => { if (!curIds.has(id)) ops.push({ t: "del", ref: auItemRef(coll, id) }); });
}

function auNormTeam(id, d) {
  return { id, name: d.name || "", logo: d.logo || "",
    purse: (d.purse === undefined ? null : d.purse),
    maxPlayers: (d.maxPlayers === undefined ? null : d.maxPlayers),
    order: d.order || 0 };
}
function auNormPlayer(id, d) {
  const p = { id, name: d.name || "", role: d.role || "", basePrice: d.basePrice || 0,
    photo: d.photo || "", status: d.status || "available",
    soldTo: d.soldTo == null ? null : d.soldTo, soldPrice: d.soldPrice == null ? null : d.soldPrice,
    retained: !!d.retained, order: d.order || 0,
    // Right to Match. These MUST be rebuilt here: this whitelist replaces
    // state.players wholesale on every snapshot, so a field missing from it is
    // wiped locally a second after it's written - which silently killed RTM
    // (the former-team link vanished and spent cards came back).
    formerTeamId: d.formerTeamId == null ? null : d.formerTeamId,
    rtmBy: d.rtmBy == null ? null : d.rtmBy };
  if (d.soldBids != null) p.soldBids = d.soldBids; // optional (Phase E)
  if (d.stats) p.stats = d.stats;                  // optional season stats (Phase E)
  return p;
}
const auDropOrder = x => { const c = { ...x }; delete c.order; return c; };

function startAuctionSync() {
  const api = auApi();
  // Generation-tagged so anything armed before a tournament switch (or a
  // resubscribe) can't act against the NEW subscriptions.
  const gen = ++auGen;
  auImgStarted = false; auImgLoaded.clear();

  // --- core text docs: tiny, and all the board actually needs to render ---
  auUnsubs.push(api.onSnapshot(auCollRef("teams"),
    snap => {const items = snap.docs.map(s => auNormTeam(s.id, s.data())).sort((a, b) => a.order - b.order);
      auMirror.teams = auClone(items); state.teams = items.map(auDropOrder); auApplyImages(); auLoaded("teams"); }, auErr));
  auUnsubs.push(api.onSnapshot(auCollRef("players"),
    snap => {const items = snap.docs.map(s => auNormPlayer(s.id, s.data())).sort((a, b) => a.order - b.order);
      auMirror.players = auClone(items); state.players = items.map(auDropOrder); auApplyImages(); auLoaded("players"); }, auErr));
  auUnsubs.push(api.onSnapshot(auStateRef("settings"),
    snap => {if (snap.exists()) { auMirror.settings = auClone(snap.data()); state.settings = { ...defaultState().settings, ...snap.data() }; }
      else auMirror.settings = null; auLoaded("settings"); }, auErr));
  auUnsubs.push(api.onSnapshot(auStateRef("live"),
    snap => {if (snap.exists()) { const d = snap.data(); auMirror.live = auClone(d);
        state.auction = { ...defaultState().auction, ...(d.auction || {}) };
        if (!Array.isArray(state.auction.bidLog)) state.auction.bidLog = [];
        state.lastAction = d.lastAction || null; }
      else auMirror.live = null; auLoaded("live"); }, auErr));

  auArmWatchdog(gen);
}

/* Photos & logos: megabytes of base64, subscribed only AFTER the board has
   rendered. Squads show their initials placeholder until these land. */
function startAuctionImageSync() {
  if (auImgStarted) return;
  auImgStarted = true;
  const api = auApi();
  auUnsubs.push(api.onSnapshot(auCollRef("playerPhotos"),
    snap => { auImg.playerPhotos = new Map(snap.docs.map(s => [s.id, s.data().data || ""]));
      auImgLoaded.add("playerPhotos"); auApplyImages(); auRemote(); }, auErr));
  auUnsubs.push(api.onSnapshot(auCollRef("teamLogos"),
    snap => { auImg.teamLogos = new Map(snap.docs.map(s => [s.id, s.data().data || ""]));
      auImgLoaded.add("teamLogos"); auApplyImages(); auRemote(); }, auErr));
}
const auImgReady = () => auImgLoaded.size === 2;

/* The watchdog only notes that we're slow - it does NOT touch the UI and never
   unsubscribes. Tearing the listeners down here is what used to turn a slow
   connection into a permanent "this device only" seconds before Firestore would
   have delivered. The flag it sets just lets a later reconnect know a retry is
   worthwhile. Skipped while the tab is hidden: a backgrounded phone stalls its
   network while timers keep ticking. */
function auArmWatchdog(gen) {
  setTimeout(() => {
    if (gen !== auGen || auFsReady || auFellBack) return;
    if (document.hidden) { auArmWatchdog(gen); return; }  // re-arm, don't judge
    auSlow = true;
    console.warn("auction sync still connecting after 8s - listeners left open, Firestore keeps retrying");
  }, 8000);
}

function auLoaded(which) {
  auFsLoaded.add(which);
  auRetries = 0; auSlow = false;
  // Not just on the false->true edge: a transient retry resubscribes the core
  // listeners while auFsReady is still true, and the images (dropped along with
  // them) have to come back too. startAuctionImageSync is idempotent.
  if (AU_CORE.every(c => auFsLoaded.has(c))) {
    auFsReady = true;
    startAuctionImageSync();  // board is up; now stream the heavy images
  }
  auRemote();
}

function auErr(err) {
  console.error("auction snapshot error:", err);
  // onSnapshot's error callback is terminal - this listener is already dead.
  // Drop the whole set and resubscribe as one, so all six stay in step.
  if (window.HCCLSync && !window.HCCLSync.isTerminal(err)) { auRetryLater(); return; }
  const code = err && err.code;
  auFallback(code === "permission-denied" ? "Cloud blocked: publish the latest Firestore rules"
    : code === "not-found" ? "Firestore database not created yet"
    : "Live sync unavailable - this device only");
}

/* Transient failure: keep cloud mode on (so edits still queue through
   Firestore) and resubscribe with backoff.
   Debounced: when the network drops, EVERY listener's error callback fires, and
   without the guard four of them would each cancel the previous retry and count
   four failures against the backoff - jumping straight to a 16s wait. */
let auRetryPending = false;
function auRetryLater() {
  if (auFellBack || !auUsingFirestore || auRetryPending) return;
  auRetryPending = true;
  const gen = ++auGen;  // disarm the dead listeners' watchdog
  auUnsubs.splice(0).forEach(u => { try { u(); } catch (e) {} });
  const wait = window.HCCLSync.backoff(auRetries++);
  auSlow = true;
  setTimeout(() => {
    auRetryPending = false;
    if (gen === auGen && !auFellBack && auUsingFirestore) startAuctionSync();
  }, wait);
}

/* Terminal failure only (bad rules, no database). */
function auFallback(msg) {
  if (auFellBack || auFsReady) return;
  auFellBack = true;
  auUnsubs.splice(0).forEach(u => { try { u(); } catch (e) {} });
  auUsingFirestore = false;
  // Only blank the board if nothing ever arrived. With the persistent cache a
  // snapshot usually HAS landed, and wiping it was what left users staring at
  // an empty auction. The local backup only holds the LEGACY tournament, so
  // never show it while another tournament is being viewed.
  if (!auFsLoaded.size)
    state = (!window.HCCLSeries || window.HCCLSeries.isLegacy()) ? normalize(load()) : normalize(null);
  toast(msg, "bad");   // the existing transient toast is the only user-facing signal
  fillSettingsInputs(); renderAll(); updateCloudUploadBtn();
}

/* Network or tab came back, or the user tapped Retry: try the cloud again.
   Recovery no longer needs a page reload. */
function auRetrySync() {
  if (!auUsingFirestore && !auFellBack) { auMaybeStartSync(); return; }
  if (auFsReady && !auSlow) return;              // already healthy
  const H = window.HCCL;
  if (!H || !H.configured || !H.user) return;
  auGen++;
  auUnsubs.splice(0).forEach(u => { try { u(); } catch (e) {} });
  auFellBack = false; auRetries = 0;
  auUsingFirestore = true;
  startAuctionSync();
  updateCloudUploadBtn();
}
function auRemote() {
  updateCloudUploadBtn();
  const ae = document.activeElement;
  if (ae && ["INPUT", "SELECT", "TEXTAREA"].includes(ae.tagName)) { auPendingRender = true; return; }
  ensureCurrentPlayer();
  fillSettingsInputs(); renderAll();
}

/* NOTE ON await: with the persistent cache enabled, batch.commit() resolves
   only when the SERVER acks. Awaiting the commits in series would leave
   auSyncing pinned true for the whole time a device is offline, and every later
   save would collapse into auSyncAgain and never replay. So the batches are
   fired and the lock is released once they're ENQUEUED - the SDK preserves
   per-client write order, and Firestore's own queue flushes them on reconnect.
   Failures are reported from allSettled below. */
async function auctionSyncDiff() {
  if (!auFsReady) return;                 // never push until we have the server baseline
  if (auSyncing) { auSyncAgain = true; return; }
  auSyncing = true;
  try {
    const api = auApi();
    const ops = [];
    AU_COLLS.forEach(coll => {
      const stripDoc = coll === "players" ? auStripPlayer : auStripTeam; // text-only (no image)
      const cur = state[coll].map((item, i) => ({ ...item, order: i })); // positional order
      const prev = auMirror[coll] || [];
      const prevMap = new Map(prev.map(x => [x.id, x]));
      const curIds = new Set(cur.map(x => x.id));
      cur.forEach(item => {
        const before = prevMap.get(item.id);
        if (!before || JSON.stringify(stripDoc(before)) !== JSON.stringify(stripDoc(item)))
          ops.push({ t: "set", ref: auItemRef(coll, item.id), data: stripDoc(item) });
      });
      prev.forEach(item => { if (!curIds.has(item.id)) ops.push({ t: "del", ref: auItemRef(coll, item.id) }); });
    });
    if (JSON.stringify(state.settings) !== JSON.stringify(auMirror.settings))
      ops.push({ t: "set", ref: auStateRef("settings"), data: auClone(state.settings) });
    const live = { auction: state.auction, lastAction: state.lastAction || null };
    if (JSON.stringify(live) !== JSON.stringify(auMirror.live))
      ops.push({ t: "set", ref: auStateRef("live"), data: auClone(live) });
    // Images go to their own one-per-doc collections (kept out of the text docs above).
    const imgOps = [];
    const canDelImg = auImgReady();
    auDiffImages("playerPhotos", state.players, p => p.photo, imgOps, canDelImg);
    auDiffImages("teamLogos",   state.teams,   t => t.logo,  imgOps, canDelImg);
    const commits = [];
    for (let i = 0; i < ops.length; i += 50) {   // text docs are light
      const batch = api.writeBatch(auDb());
      ops.slice(i, i + 50).forEach(op => op.t === "set" ? batch.set(op.ref, op.data) : batch.delete(op.ref));
      commits.push(batch.commit());
    }
    for (let i = 0; i < imgOps.length; i += 6) {  // images are big - tiny batches stay under the request-size cap
      const batch = api.writeBatch(auDb());
      imgOps.slice(i, i + 6).forEach(op => op.t === "set" ? batch.set(op.ref, op.data) : batch.delete(op.ref));
      commits.push(batch.commit());
    }
    Promise.allSettled(commits).then(rs => {
      const bad = rs.find(r => r.status === "rejected");
      if (bad) { console.error("auction sync failed:", bad.reason); toast("Couldn't save to the cloud", "bad"); }
    });
    auMirror.teams = auClone(state.teams.map((t, i) => ({ ...t, order: i })));
    auMirror.players = auClone(state.players.map((p, i) => ({ ...p, order: i })));
    auMirror.settings = auClone(state.settings);
    auMirror.live = auClone(live);
    // reflect the images we just wrote so the next diff is a no-op until they actually change
    auImg.playerPhotos = new Map(state.players.filter(p => p.photo).map(p => [p.id, p.photo]));
    auImg.teamLogos    = new Map(state.teams.filter(t => t.logo).map(t => [t.id, t.logo]));
  } catch (e) {
    console.error("auction sync failed:", e);
    toast("Couldn't save to the cloud", "bad");
  } finally {
    auSyncing = false;
    if (auSyncAgain) { auSyncAgain = false; auctionSyncDiff(); }
  }
}

function updateCloudUploadBtn() {
  const row = $("#cloudUploadRow"); if (row) row.classList.toggle("hidden", !auUsingFirestore);
}
function uploadAuctionToCloud() {
  if (!auUsingFirestore || !auCanEdit()) { toast("Cloud editing isn't available", "bad"); return; }
  const local = normalize(load());
  if (!local.teams.length && !local.players.length) { toast("No saved auction data on this device", "bad"); return; }
  if (!confirm(`Add this device's ${local.teams.length} teams and ${local.players.length} players to the shared cloud auction?`)) return;
  // Add brand-new teams/players; for ones already in the cloud, backfill a missing
  // logo/photo from this device so the one-time upload actually pushes the images.
  const teamById = new Map(state.teams.map(t => [t.id, t]));
  local.teams.forEach(t => {
    const ex = teamById.get(t.id);
    if (!ex) state.teams.push(t);
    else if (!ex.logo && t.logo) ex.logo = t.logo;
  });
  const playerById = new Map(state.players.map(p => [p.id, p]));
  local.players.forEach(p => {
    const ex = playerById.get(p.id);
    if (!ex) state.players.push(p);
    else if (!ex.photo && p.photo) ex.photo = p.photo;
  });
  if (!auMirror.settings) state.settings = { ...state.settings, ...local.settings };
  save(); fillSettingsInputs(); renderAll(); toast("Uploading auction to the cloud…", "good");
}

/* ---------- utilities ---------- */
const uid = () => "id" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function initials(str) {
  if (!str) return "?";
  return str.trim().split(/\s+/).slice(0, 2).map(w => w[0] || "").join("").toUpperCase();
}

function money(n) {
  if (n === null || n === undefined || isNaN(n)) return "-";
  const num = Number(n);
  const s = Number.isInteger(num) ? String(num) : String(parseFloat(num.toFixed(2)));
  return `${s} ${state.settings.currency}`;
}

/* ---------- retention categories ----------
   The "Role / category" dropdown in the Retain / Pre-assign form. The chosen
   category becomes the player's tag EVERYWHERE a retained player shows up
   (squads, Players page, fixtures line-ups) - replacing the old blanket "RET".
   Kept global (app.js is global scope) so fixtures.js can read the same tag. */
const RETAIN_CATEGORIES = [
  { value: "Captain",     tag: "CAP" },
  { value: "Pre-signed",  tag: "PRE" },
  { value: "Retained",    tag: "RET" },
  { value: "Batsman",     tag: "BAT" },
  { value: "Bowler",      tag: "BWL" },
  { value: "All-rounder", tag: "AR"  },
];
// Short tag for a retained player's category. Blank / anything not in the list
// falls back to RET - they're still a retained player (that's the section).
function retainTag(role) {
  const r = String(role || "").trim().toLowerCase();
  const hit = RETAIN_CATEGORIES.find(c => c.value.toLowerCase() === r);
  return hit ? hit.tag : "RET";
}
// CSS accent hook: rt-cap / rt-pre / rt-ret / rt-bat / rt-bwl / rt-ar.
function retainTagClass(role) { return "rt-" + retainTag(role).toLowerCase(); }
// The full category word for detail lines. A custom/legacy value is shown as
// typed; blank falls back to "Retained".
function retainLabel(role) {
  const raw = String(role || "").trim();
  const hit = RETAIN_CATEGORIES.find(c => c.value.toLowerCase() === raw.toLowerCase());
  return hit ? hit.value : (raw || "Retained");
}

const getTeam = id => state.teams.find(t => t.id === id);
const getPlayer = id => state.players.find(p => p.id === id);
const currentPlayer = () => getPlayer(state.auction.currentPlayerId);

function teamPurse(t)    { return t.purse !== null && t.purse !== undefined ? t.purse : state.settings.defaultPurse; }
function teamSpent(id)   { return state.players.filter(p => p.status === "sold" && !p.retained && p.soldTo === id).reduce((s, p) => s + (p.soldPrice || 0), 0); }
function teamRemaining(t){ return teamPurse(t) - teamSpent(t.id); }
function teamPlayers(id) { return state.players.filter(p => p.status === "sold" && p.soldTo === id); }

/* Squad cap. Configurable in Setup: settings.squadSize is the league default and a
   team may override it with team.maxPlayers (null = use the league default). */
const DEFAULT_SQUAD_SIZE = 5;
/* Cap for one team, resolved against a state-like `s` (so the bid transaction can run
   it against the SERVER snapshot). Falls back to 5 for data saved before this setting. */
function squadCapOf(s, team) {
  if (team && team.maxPlayers != null) return Math.max(1, Number(team.maxPlayers) || DEFAULT_SQUAD_SIZE);
  const def = s && s.settings ? Number(s.settings.squadSize) : 0;
  return Math.max(1, def || DEFAULT_SQUAD_SIZE);
}
/* Convenience for the render paths, which all read the global `state`. */
function teamCap(t) { return squadCapOf(state, t); }

/* Budget + slot math for one team - DERIVED ONLY (no writes). Takes a state-like `s`
   so the bid transaction can run it against the SERVER's live auction snapshot.
     remainingSlots = maxPlayers - squad.length
     reserve        = max(0, remainingSlots - 1) * minimumBasePrice (of available players)
     safeBid        = remainingPurse - reserve
   safeBid is the most a team can bid now and still afford to fill its empty slots. */
function squadInfo(s, teamId) {
  const team = s.teams.find(t => t.id === teamId);
  const sold = s.players.filter(p => p.status === "sold" && p.soldTo === teamId);
  const squadCount = sold.length;                                  // retained players count too
  const maxPlayers = squadCapOf(s, team);
  const slotsLeft = Math.max(0, maxPlayers - squadCount);
  const purse = (team && team.purse != null) ? team.purse : s.settings.defaultPurse;
  const spent = sold.filter(p => !p.retained).reduce((x, p) => x + (p.soldPrice || 0), 0);
  const remaining = purse - spent;
  const avail = s.players.filter(p => p.status === "available").map(p => Number(p.basePrice) || 0);
  const minBase = avail.length ? Math.min(...avail) : 0;
  const reserve = Math.max(0, slotsLeft - 1) * minBase;
  const safeBid = remaining - reserve;
  return { squadCount, maxPlayers, slotsLeft, purse, spent, remaining, minBase, reserve, safeBid };
}

/* ============================================================
   RIGHT TO MATCH (RTM)
   A player's LAST-SEASON franchise may reclaim him when he's about to be sold
   to someone else, by matching the STANDING BID: if bidding closed at 15 Cr,
   the card buys him at exactly 15 Cr. There is no price-raise step - one
   decision, Use RTM or Pass.

   Everything here is DERIVED (no stored counters) - the same discipline as
   teamSpent/squadInfo. In particular the RTM card count is computed from the
   players a team actually signed via RTM, so Undo hands the card straight back
   and a counter can never drift out of step with the squad.
   ============================================================ */

// Is RTM in play at all? Off for fixed-squad tournaments (no auction) and when
// the league switched it off.
function rtmOn(s) {
  s = s || state;
  if (!s.settings || s.settings.rtmEnabled === false) return false;
  if (window.HCCLSeries && typeof window.HCCLSeries.hasAuction === "function"
      && !window.HCCLSeries.hasAuction()) return false;
  return true;
}
const rtmCardsPerTeam = s => Math.max(0, Number((s || state).settings.rtmCards ?? 1) || 0);
// Cards SPENT = players this team currently holds that it signed with an RTM.
function rtmUsed(s, teamId) {
  s = s || state;
  return s.players.filter(p => p.status === "sold" && p.soldTo === teamId && p.rtmBy === teamId).length;
}
function rtmLeft(s, teamId) {
  s = s || state;
  return Math.max(0, rtmCardsPerTeam(s) - rtmUsed(s, teamId));
}

/* The team that held this player last season, or "" when there isn't one.
   "none" is an explicit "nobody" set by an admin; a stale id (team deleted
   since) resolves to "". */
function formerTeamIdOf(s, player) {
  s = s || state;
  const raw = player && player.formerTeamId;
  if (!raw || raw === "none") return "";
  return s.teams.some(t => t.id === raw) ? raw : "";
}

/* Can the former team invoke RTM on this sale? Reuses the SAME squad-cap and
   Safe-Bid guards as a normal bid, so an RTM can never break a squad or budget.
   Returns { ok, formerTeamId, reason }. */
function rtmEligible(s, player, winnerTeamId, price) {
  s = s || state;
  if (!rtmOn(s)) return { ok: false, reason: "off" };
  if (!player || player.retained) return { ok: false, reason: "no-player" };
  const formerTeamId = formerTeamIdOf(s, player);
  if (!formerTeamId) return { ok: false, reason: "no-former-team" };
  if (formerTeamId === winnerTeamId) return { ok: false, formerTeamId, reason: "already-theirs" };
  if (rtmLeft(s, formerTeamId) <= 0) return { ok: false, formerTeamId, reason: "no-card" };
  const info = squadInfo(s, formerTeamId);
  if (info.slotsLeft <= 0) return { ok: false, formerTeamId, reason: "squad-full" };
  if (info.safeBid < price) return { ok: false, formerTeamId, reason: "cant-afford" };
  return { ok: true, formerTeamId, reason: "" };
}


/* turn an image File into a resized data URL so it fits in localStorage */
function fileToDataURL(file, maxSize = 400, format = "jpeg") {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Could not read image"));
      img.onload = () => {
        let { width: w, height: h } = img;
        if (w > h && w > maxSize) { h = Math.round(h * maxSize / w); w = maxSize; }
        else if (h > maxSize)     { w = Math.round(w * maxSize / h); h = maxSize; }
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(format === "png" ? c.toDataURL("image/png") : c.toDataURL("image/jpeg", 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* small visual helpers */
function logoHTML(cls, img, name) {
  const style = img ? `style="background-image:url('${img}')"` : "";
  return `<span class="${cls}" ${style}>${img ? "" : esc(initials(name))}</span>`;
}
function setPhoto(el, img, fallback) {
  if (img) { el.style.backgroundImage = `url('${img}')`; el.textContent = ""; }
  else { el.style.backgroundImage = ""; el.textContent = fallback; }
}

let toastTimer;
function toast(msg, kind = "") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2400);
}

/* Header status chip for live sync. A toast lasts 2.4s; someone who looks away
   during a slow load used to be left with an empty board and no explanation.
   This stays on screen for as long as the condition does, and offers a Retry. */
/* ============================================================
   TABS
   ============================================================ */
/* Old top-level tab names -> their new home after the nav regrouping.
   Squads lives under Auctions; Player Ranking IS the Rankings view now.
   Keeps every legacy switchTab()/[data-goto] call working. */
const TAB_ALIASES = {
  squads:  { tab: "auctions", sub: "squads" },
  ranking: { tab: "rankings" },   // Player Ranking is the whole Rankings view
};

/* Fixtures, MVP and Fantasy moved INSIDE the tournament page (Cricbuzz-style
   inner tabs). A legacy switchTab("fixtures"|"mvp"|"fantasy") - or the Fantasy
   nav pill / any [data-goto] - opens the tournament page on that inner tab. */
const HUB_TABS = { fixtures: "matches", mvp: "mvp", fantasy: "fantasy" };

function switchTab(name) {
  const hub = HUB_TABS[name];
  if (hub) {
    switchTab("series");
    if (window.HCCLSeries && window.HCCLSeries.openHub) window.HCCLSeries.openHub(hub);
    return;
  }
  const alias = TAB_ALIASES[name];
  if (alias) { switchTab(alias.tab); if (alias.sub) switchSubTab(alias.sub); return; }
  // Viewers never get the Setup surface - not via the tab, not via any
  // [data-goto="setup"] shortcut, not via a direct switchTab call. Same for the
  // Members & engagement board (admin/moderator only).
  if ((name === "setup" || name === "members") && !auCanEdit()) name = "home";
  $$(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
  $$(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + name));
  // Open the new view at the top - otherwise it keeps the old view's scroll
  // offset and its controls land hidden underneath the sticky header.
  window.scrollTo(0, 0);
  // Keep the active pill in sight in the swipeable mobile nav bar.
  const active = $(".tab.active");
  if (active && active.scrollIntoView) active.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
}

/* Sub-tabs: each section owns its own group (Auction: Room / Players /
   Teams & Purse / Squads / Dashboard - Rankings: MVP / Player Ranking).
   Toggling is scoped to the group's `.view` so one bar never disturbs
   the other section's selection. */
function switchSubTab(name) {
  const btn = $$(".subtab").find(t => t.dataset.subtab === name);
  const scope = btn ? btn.closest(".view") : null;
  if (!scope) return;
  $$(".subtab", scope).forEach(t => t.classList.toggle("active", t.dataset.subtab === name));
  $$(".subview", scope).forEach(v => v.classList.toggle("active", v.id === "subview-" + name));
  window.scrollTo(0, 0); // same reason as switchTab
  if (name === "dashboard") renderInsights(); // build charts now that the dashboard is visible
}

/* Jump to the Auctions section, optionally to a sub-tab (defaults to the Auction Room). */
function goAuctions(sub = "auction") { switchTab("auctions"); switchSubTab(sub); }

/* ============================================================
   RENDER
   ============================================================ */
function renderAll() {
  renderHeader();
  renderAuction();
  renderPlayers();
  renderPurse();
  renderSquads();
  renderSetup();
  renderInsights();
  // Members board: clear it whenever the role can't see it (a demotion must not
  // leave stale member data in the DOM), and refresh it while it's open.
  if (window.HCCLMembers) {
    const mv = $("#view-members");
    if (!auCanEdit() || (mv && mv.classList.contains("active"))) window.HCCLMembers.render();
  }
  // Sibling modules (fixtures.js) read teams/squads through window.HCCLAuction;
  // this tells them the underlying data just changed (cloud snapshot, edit, …).
  document.dispatchEvent(new CustomEvent("hccl:data"));
}

/* Read-only view of the auction data for sibling modules. Keeps them decoupled
   from `state` while still resolving squads from the SAME teams/players the
   auction owns - in both cloud and localStorage mode. */
window.HCCLAuction = {
  teams:    () => state.teams.map(t => ({ id: t.id, name: t.name, logo: t.logo || "" })),
  squad:    id => teamPlayers(id).map(p => ({ id: p.id, name: p.name, role: p.role || "", photo: p.photo || "", retained: !!p.retained, rtm: !!p.rtmBy, soldPrice: p.soldPrice != null ? p.soldPrice : null })),
  team:     id => { const t = getTeam(id); return t ? { id: t.id, name: t.name, logo: t.logo || "" } : null; },
  players:  () => state.players.map(p => ({ id: p.id, name: p.name, role: p.role || "", photo: p.photo || "", retained: !!p.retained, rtm: !!p.rtmBy, status: p.status, soldTo: p.soldTo || null, soldPrice: p.soldPrice != null ? p.soldPrice : null })),
  money,
  settings: () => ({ ...state.settings }),
};

function renderHeader() {
  // The header carries the SITE brand (HC Community), not the viewed tournament -
  // that identity lives in the Series tab and the viewing banner. The brand
  // badge / favicon stay on the static assets/brand-logo.jpeg from index.html.
  document.title = "HC Community";
}

/* ---------- LIVE AUCTION ---------- */
function ensureCurrentPlayer() {
  const a = state.auction;
  if (a.lastResult) return; // hold on the player whose result is on screen
  const cur = a.currentPlayerId ? getPlayer(a.currentPlayerId) : null;
  if (!cur) {
    const next = state.players.find(p => p.status === "available");
    const nextId = next ? next.id : null;
    if ((a.currentPlayerId || null) !== nextId) { a.currentPlayerId = nextId; resetBidState(); }
  } else if (cur.status !== "available") {
    const next = state.players.find(p => p.status === "available");
    a.currentPlayerId = next ? next.id : null;
    resetBidState();
  }
}

function renderAuction() {
  ensureCurrentPlayer();
  renderSquadTracker();
  const player = currentPlayer();
  const stage = $("#auctionStage");
  const empty = $("#auctionEmpty");

  if (!player) {
    stage.classList.add("hidden");
    empty.classList.remove("hidden");
    if (state.players.length === 0) {
      // Editors get the Setup shortcut; viewers just get a friendly notice.
      empty.innerHTML = auCanEdit()
        ? `<h2>No players to auction yet</h2>
          <p>Go to the <strong>⚙️ Setup</strong> tab to add teams and players, or load the sample data to try it out.</p>
          <button class="btn btn-yellow" data-goto="setup">Open Setup</button>`
        : `<h2>No players to auction yet</h2>
          <p>The auction for this tournament hasn't been set up - check back soon!</p>`;
    } else {
      const sold = state.players.filter(p => p.status === "sold").length;
      const unsold = state.players.filter(p => p.status === "unsold").length;
      empty.innerHTML = `<h2>🏆 Auction Complete</h2>
        <p>${sold} sold · ${unsold} unsold.</p>
        <div class="form-row" style="justify-content:center">
          ${(unsold && auCanEdit()) ? `<button class="btn btn-yellow" id="btnReauction2">Re-open ${unsold} unsold</button>` : ""}
          <button class="btn btn-dark" data-goto="squads">View Squads</button>
        </div>`;
      const rb = $("#btnReauction2");
      if (rb) rb.onclick = reauctionUnsold;
    }
    // Same shared-overlay handling as the normal path below - without this,
    // the LAST player's SOLD/UNSOLD overlay could never be dismissed ("Next
    // Player" clears lastResult, but this early return skipped hideOverlay()).
    if (state.auction.lastResult) showResultView(state.auction.lastResult);
    else hideOverlay();
    return;
  }

  empty.classList.add("hidden");
  stage.classList.remove("hidden");
  const a = state.auction;

  // Player card
  setPhoto($("#playerPhoto"), player.photo, initials(player.name));
  $("#playerName").textContent = player.name;
  $("#playerRole").textContent = player.role || "";
  // Last-season franchise (drives Right to Match) - shown on the block so the
  // room knows an RTM is possible before bidding closes.
  const roleBox = $("#playerRole");
  const prevChip = roleBox ? roleBox.parentElement.querySelector(".rtm-former") : null;
  if (prevChip) prevChip.remove();
  const ftId = rtmOn(state) ? formerTeamIdOf(state, player) : "";
  if (ftId && roleBox) {
    const ft = getTeam(ftId);
    const chip = document.createElement("div");
    chip.className = "rtm-former";
    chip.textContent = `RTM  last season: ${ft ? ft.name : ""}`;
    roleBox.insertAdjacentElement("afterend", chip);
  }
  $("#playerBase").textContent = money(player.basePrice);
  const queue = state.players.filter(p => !p.retained);
  $("#playerCounter").textContent = `Player ${queue.indexOf(player) + 1} / ${queue.length}`;
  renderSeasonStats(player);

  // Current bid box
  const leader = a.currentBidderId ? getTeam(a.currentBidderId) : null;
  $("#currentBidAmount").textContent = leader ? money(a.currentBid) : money(player.basePrice);
  $("#currentLeader").textContent = leader ? leader.name : "No bids yet";
  $("#currentLeader").style.color = leader ? "var(--yellow)" : "var(--muted)";

  renderTeamButtons();
  renderRtmPanel();
  renderSoldButton();
  renderBidLog();

  // shared result overlay (driven by state so every device matches)
  if (a.lastResult) showResultView(a.lastResult);
  else hideOverlay();
}

function nextBidAmount() {
  const a = state.auction, player = currentPlayer();
  if (!player) return 0;
  return a.currentBidderId == null ? player.basePrice : a.currentBid + state.settings.bidIncrement;
}

/* Optional "Season Stats" card under the player photo (only when the player has stats). */
function renderSeasonStats(player) {
  const box = $("#seasonStats");
  if (!box) return;
  const s = player && player.stats;
  const has = s && Object.keys(s).some(k => s[k] !== "" && s[k] != null);
  if (!has) { box.classList.add("hidden"); box.innerHTML = ""; return; }
  const fmtPrev = v => { const n = Number(v); return isNaN(n) ? v : money(n); };
  const row = (label, val, fmt) => (val === "" || val == null) ? ""
    : `<div><span class="ss-k">${esc(label)}</span><span class="ss-v">${esc(String(fmt ? fmt(val) : val))}</span></div>`;
  box.classList.remove("hidden");
  box.innerHTML = `<div class="ss-title">Player Stats</div><div class="ss-grid">
    ${row("Matches", s.matches)}${row("Runs", s.runs)}${row("Wickets", s.wickets)}
    ${row("Strike Rate", s.strikeRate)}${row("Economy", s.economy)}${row("Average", s.average)}
    ${row("Fantasy Pts", s.fantasyPoints)}${row("Prev Price", s.previousPrice, fmtPrev)}
  </div>`;
}

function renderTeamButtons() {
  const grid = $("#teamsBidGrid");
  grid.innerHTML = "";
  const a = state.auction;
  const next = nextBidAmount();

  if (!state.teams.length) {
    grid.innerHTML = `<p class="hint">No teams yet. Add teams in the ⚙️ Setup tab.</p>`;
    return;
  }

  state.teams.forEach((t, i) => {
    const info = squadInfo(state, t.id);
    const leading = a.currentBidderId === t.id;
    const full = info.slotsLeft <= 0;
    const overSafe = info.safeBid < next;
    const btn = document.createElement("button");
    btn.className = "team-bid-btn" + (leading ? " leading" : "");
    btn.disabled = leading || full || overSafe;
    btn.title = leading ? "Currently leading"
      : full ? `Squad full (${info.maxPlayers} players)`
      : overSafe ? "Cannot exceed Safe Bid and still complete squad"
      : `Bid ${money(next)} for ${t.name}`;
    btn.innerHTML = `
      ${logoHTML("tb-logo", t.logo, t.name)}
      <span class="tb-meta">
        <span class="tb-name">${esc(t.name)}</span>
        <span class="tb-purse">
          <span class="tb-purse-txt">${leading ? "★ Leading" : money(info.remaining) + " left"}</span>
          ${rtmOn(state) && rtmLeft(state, t.id) > 0
            ? `<i class="rtm-badge" title="Right to Match card still in hand">RTM</i>` : ""}
        </span>
      </span>
      ${i < 9 ? `<span class="tb-key">${i + 1}</span>` : ""}`;
    btn.onclick = () => placeBid(t.id);
    grid.appendChild(btn);
  });
}

/* Live Squad Tracker - one card per team, visible to everyone. Derived only. */
function renderSquadTracker() {
  const box = $("#squadTracker");
  if (!box) return;
  if (!state.teams.length) { box.innerHTML = ""; return; }
  const a = state.auction;
  box.innerHTML = `<h3 class="tracker-title">📋 Squad Tracker</h3>
    <div class="tracker-grid">${state.teams.map(t => {
      const info = squadInfo(state, t.id);
      const bought = state.players.filter(p => p.status === "sold" && !p.retained && p.soldTo === t.id);
      const avg = bought.length ? info.spent / bought.length : 0;
      const fillPct = info.maxPlayers > 0 ? (info.squadCount / info.maxPlayers) * 100 : 0; // bar tracks squad completion
      const budgetPct = info.purse > 0 ? Math.max(0, Math.min(100, (info.remaining / info.purse) * 100)) : 0;
      const health = info.slotsLeft <= 0 ? "full" : budgetPct >= 50 ? "good" : budgetPct >= 25 ? "warn" : "bad";
      const dots = Array.from({ length: info.maxPlayers }, (_, k) =>
        `<span class="dot${k < info.squadCount ? " on" : ""}"></span>`).join("");
      const leading = a.currentBidderId === t.id;
      return `<div class="tracker-card ${health}${leading ? " leading" : ""}">
        <div class="tc-head">${logoHTML("tc-logo", t.logo, t.name)}<span class="tc-name">${esc(t.name)}</span></div>
        <div class="tc-dots" title="${info.squadCount} of ${info.maxPlayers} players">${dots}</div>
        <div class="tc-players">${info.squadCount} / ${info.maxPlayers} Players${
          rtmOn(state) && rtmCardsPerTeam(state) > 0 && rtmLeft(state, t.id) > 0
            ? `<i class="rtm-badge inline" title="Right to Match card still in hand">RTM</i>` : ""}</div>
        <div class="tc-bar"><span style="width:${fillPct}%"></span></div>
        <div class="tc-stats">
          <div><span class="tc-k">Purse</span><span class="tc-v">${money(info.remaining)}</span></div>
          <div><span class="tc-k">Slots</span><span class="tc-v">${info.slotsLeft}</span></div>
          <div><span class="tc-k">Safe Bid</span><span class="tc-v safe">${money(Math.max(0, info.safeBid))}</span></div>
          <div><span class="tc-k">Avg Spend</span><span class="tc-v">${bought.length ? money(avg) : "-"}</span></div>
        </div>
      </div>`;
    }).join("")}</div>`;
}


/* ---------------- RTM panel ----------------
   Rendered from state.auction.rtm, so it looks identical on every device.
   Action buttons are wrapped in .rtm-actions, which the existing
   `body:not(.can-edit)` rule hides - viewers get the prompt + clock, no controls. */
let rtmTick = null;
function stopRtmClock() { if (rtmTick) { clearInterval(rtmTick); rtmTick = null; } }

function rtmClockHtml(endsAt) {
  const left = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
  const over = left <= 0;
  return `<span class="rtm-clock${over ? " over" : ""}" data-rtm-clock="${endsAt}">${
    over ? "TIME UP" : left + "s"}</span>`;
}

function renderRtmPanel() {
  const box = $("#rtmPanel");
  if (!box) return;
  stopRtmClock();
  const r = state.auction.rtm;
  if (!r) { box.classList.add("hidden"); box.innerHTML = ""; return; }

  const ft = getTeam(r.formerTeamId), win = getTeam(r.winnerTeamId);
  const player = getPlayer(r.playerId);
  const ftName = ft ? ft.name : "Former team";
  const winName = win ? win.name : "the bidder";
  const info = ft ? squadInfo(state, ft.id) : null;
  const badge = logoHTML("team-logo", ft ? ft.logo : "", ftName);

  // One decision, at the standing bid - no raise step.
  const afford = info && info.safeBid >= r.bidPrice && info.slotsLeft > 0;
  const head = `${ftName} may match ${money(r.bidPrice)}`;
  const body = `<b>${esc(player ? player.name : "")}</b> played for <b>${esc(ftName)}</b> last season.
    Using the card signs him at <b>${money(r.bidPrice)}</b> - the same price
    <b>${esc(winName)}</b> bid. Passing sells him to <b>${esc(winName)}</b>.`;
  const actions = `<button class="btn btn-yellow" data-rtm="use" ${afford ? "" : "disabled"}
                     title="${afford ? "" : "Beyond their Safe Bid or squad is full"}">Use RTM  ${money(r.bidPrice)}</button>
                   <button class="btn btn-dark" data-rtm="pass">Pass</button>`;

  box.classList.remove("hidden");
  box.innerHTML = `
    <div class="rtm-head">
      <span class="rtm-tag">RIGHT TO MATCH</span>
      ${rtmClockHtml(r.endsAt)}
    </div>
    <div class="rtm-body">
      ${badge}
      <div class="rtm-text">
        <div class="rtm-title">${esc(head)}</div>
        <div class="rtm-sub">${body}</div>
        ${info ? `<div class="rtm-meta">${esc(ftName)}: ${money(info.remaining)} left  ${info.slotsLeft} slot${info.slotsLeft === 1 ? "" : "s"}  RTM ${rtmLeft(state, r.formerTeamId)}/${rtmCardsPerTeam(state)}</div>` : ""}
      </div>
    </div>
    <div class="rtm-actions">${actions}
      <button class="btn btn-dark rtm-cancel" data-rtm="cancel" title="Abandon RTM and sell to the leading bidder">Cancel RTM</button>
    </div>`;

  // Advisory clock only - it never commits anything.
  rtmTick = setInterval(() => {
    const el = $("[data-rtm-clock]");
    if (!el) { stopRtmClock(); return; }
    const ends = Number(el.getAttribute("data-rtm-clock")) || 0;
    const left = Math.max(0, Math.ceil((ends - Date.now()) / 1000));
    el.textContent = left <= 0 ? "TIME UP" : left + "s";
    el.classList.toggle("over", left <= 0);
  }, 250);
}

function renderSoldButton() {
  const btn = $("#btnSold");
  const a = state.auction;
  if (a.rtm) { btn.textContent = "RTM in progress"; btn.className = "btn btn-sold"; btn.disabled = true; return; }
  const labels = { 0: "SOLD", 1: "GOING ONCE!", 2: "GOING TWICE!", 3: "GOING THRICESELL!" };
  btn.className = "btn btn-sold" + (a.soldStage ? ` stage-${a.soldStage}` : "");
  btn.textContent = labels[a.soldStage];
  btn.disabled = a.currentBidderId == null;
}

function renderBidLog() {
  const box = $("#bidLog");
  box.innerHTML = "";
  state.auction.bidLog.slice().reverse().forEach(b => {
    const t = getTeam(b.teamId);
    const row = document.createElement("div");
    row.className = "bidlog-row";
    row.innerHTML = `<b>${esc(t ? t.name : "?")}</b> bid <span class="amt">${money(b.amount)}</span>`;
    box.appendChild(row);
  });
}

/* ---------- auction actions ---------- */
function resetBidState() {
  const a = state.auction;
  a.currentBid = 0; a.currentBidderId = null; a.soldStage = 0; a.bidLog = [];
}

/* Pure bid rule. Returns the new auction object, or null if the bid isn't allowed.
   Enforces the configured squad cap (settings.squadSize / team.maxPlayers) and the
   Safe Bid budget guard (see squadInfo). */
function computeBidResult(s, teamId) {
  const a = s.auction;
  if (!a || a.lastResult) return null;                 // not while a SOLD/UNSOLD result is showing
  if (a.currentBidderId === teamId) return null;       // can't out-bid yourself
  const player = s.players.find(p => p.id === a.currentPlayerId);
  if (!player || player.status !== "available") return null; // only the player on the block
  const inc = Number(s.settings.bidIncrement) || 1;
  const amount = a.currentBidderId == null ? player.basePrice : a.currentBid + inc;
  const team = s.teams.find(t => t.id === teamId);
  if (!team) return null;
  const info = squadInfo(s, teamId);
  if (info.slotsLeft <= 0) return null;   // squad already full (at its squad cap)
  if (info.safeBid < amount) return null; // would break squad-completion budget
  return {
    currentPlayerId: a.currentPlayerId,
    currentBid: amount, currentBidderId: teamId, soldStage: 0,
    bidLog: [...(a.bidLog || []), { teamId, amount }],
    lastResult: null,
  };
}

/* Place a bid (auctioneer-driven). Mutates local state; save() syncs it to the cloud. */
function placeBid(teamId) {
  const res = computeBidResult(state, teamId);
  if (!res) { const t = getTeam(teamId); if (t) toast(`${t.name} can't place that bid`, "bad"); return; }
  state.auction = res;
  save();
  renderAuction();
}

function advanceSold() {  const a = state.auction;
  if (a.rtm) return;                    // an RTM handshake owns the board right now
  if (a.currentBidderId == null) { toast("No bids yetuse Unsold instead", "bad"); return; }
  if (a.soldStage < 3) { a.soldStage++; save(); renderSoldButton(); }
  // The final tap doesn't sell outright any more: if the player's last-season
  // team can match, pause here and let them decide (maybeStartRtm returns true).
  else if (!maybeStartRtm()) { finalizeSold(); }
}

/* Sell the player on the block. Defaults to the winning bidder at the standing
   bid; the RTM paths pass an explicit team/price (and viaRtm to spend the card). */
function finalizeSold(opts) {
  const player = currentPlayer();
  const a = state.auction;
  const o = opts || {};
  const teamId = o.teamId != null ? o.teamId : a.currentBidderId;
  const team = getTeam(teamId);
  if (!player || !team) return;
  const price = o.price != null ? o.price : a.currentBid;
  player.status = "sold";
  player.soldTo = team.id;
  player.soldPrice = price;
  player.soldBids = (a.bidLog || []).length; // bid count, for the Insights "Biggest Bid War"
  // Spending the card is recorded ON THE PLAYER - that's what makes rtmLeft()
  // derived, and what makes Undo give the card back for free.
  player.rtmBy = o.viaRtm ? team.id : null;
  state.lastAction = { type: "sold", playerId: player.id };
  a.rtm = null;
  a.lastResult = { type: "sold", playerId: player.id, playerName: player.name,
                   teamId: team.id, teamName: team.name, price, viaRtm: !!o.viaRtm };
  resetBidState();
  save();
  renderAll();
}

/* ---------------- RTM handshake (auctioneer-driven, synced to everyone) ----------------
   ONE decision: the former team either matches the standing bid or passes.
   There is no price raise - if bidding closed at 15 Cr, the card buys him at
   exactly 15 Cr. Each step writes state.auction.rtm and save()s, so the live
   doc broadcasts the same board to every device. The countdown is ADVISORY:
   endsAt only drives the on-screen clock - nothing auto-commits, the
   auctioneer always taps. */
const RTM_WINDOW_MS = 15000;

// Called on the final SOLD tap. Returns true when it opened an RTM prompt
// (so the caller must NOT sell), false to sell normally.
function maybeStartRtm() {
  const a = state.auction;
  const player = currentPlayer();
  const price = a.currentBid;
  const el = rtmEligible(state, player, a.currentBidderId, price);
  if (!el.ok) return false;
  a.rtm = {
    phase: "prompt",
    playerId: player.id,
    formerTeamId: el.formerTeamId,
    winnerTeamId: a.currentBidderId,
    bidPrice: price,          // the price the card buys him at - never changes
    endsAt: Date.now() + RTM_WINDOW_MS,
  };
  save();
  renderAll();
  const ft = getTeam(el.formerTeamId);
  toast(`Right to Match  ${ft ? ft.name : "former team"} may match ${money(price)}`, "good");
  return true;
}

// Guard shared by every RTM action: editors only, and only while a prompt is up.
function rtmAct() {
  if (!auCanEdit()) { toast("Only admins/moderators can run the auction", "bad"); return null; }
  return state.auction.rtm || null;
}

/* Use the card: the former team signs him at the STANDING BID, card spent. */
function rtmUse() {
  const r = rtmAct(); if (!r) return;
  const player = currentPlayer();
  // Re-check at commit time - another device may have changed the squad/purse.
  const el = rtmEligible(state, player, r.winnerTeamId, r.bidPrice);
  if (!el.ok || el.formerTeamId !== r.formerTeamId) {
    toast(el.reason === "cant-afford" ? "They can no longer afford that price"
        : el.reason === "squad-full" ? "Their squad is full"
        : "RTM is no longer available", "bad");
    return;
  }
  finalizeSold({ teamId: r.formerTeamId, price: r.bidPrice, viaRtm: true });
}

/* Pass: they let him go - normal sale to the winning bidder at the same price. */
function rtmPass() {
  const r = rtmAct(); if (!r) return;
  finalizeSold({ teamId: r.winnerTeamId, price: r.bidPrice });
}

/* Auctioneer escape hatch: abandon the handshake and hand the player to the
   winning bidder at the standing bid (same outcome as Pass, kept as a
   distinct, clearly-labelled control). */
function rtmCancel() {
  const r = rtmAct(); if (!r) return;
  finalizeSold({ teamId: r.winnerTeamId, price: r.bidPrice });
}

function markUnsold() {  const player = currentPlayer();
  if (!player) return;
  player.status = "unsold";
  player.soldTo = null;
  player.soldPrice = null;
  state.lastAction = { type: "unsold", playerId: player.id };
  state.auction.lastResult = { type: "unsold", playerId: player.id, playerName: player.name };
  state.auction.rtm = null;
  resetBidState();
  save();
  renderAll();
}

function nextPlayer() {  const a = state.auction;
  a.lastResult = null;
  a.rtm = null;
  const next = state.players.find(p => p.status === "available");
  a.currentPlayerId = next ? next.id : null;
  resetBidState();
  save();
  renderAll();
}

function resetBid() {  state.auction.rtm = null;
  resetBidState();
  save();
  renderAuction();
  toast("Bids cleared for this player");
}

function undoLast() {  const la = state.lastAction;
  if (!la) { toast("Nothing to undo", "bad"); return; }
  const player = getPlayer(la.playerId);
  if (player) {
    player.status = "available";
    player.soldTo = null;
    player.soldPrice = null;
    player.rtmBy = null;   // spending is derived from this - clearing it returns the RTM card
    state.auction.currentPlayerId = player.id; // bring them back to the block
  }
  state.lastAction = null;
  state.auction.lastResult = null;
  state.auction.rtm = null;
  resetBidState();
  save();
  renderAll();
  toast("Last action undone", "good");
}

function auctionNow(playerId) {
  const p = getPlayer(playerId);
  if (!p) return;
  if (p.status === "unsold") p.status = "available";
  if (p.status !== "available") { toast("Already solduse Undo first", "bad"); return; }
  state.auction.currentPlayerId = playerId;
  state.auction.lastResult = null;
  state.auction.rtm = null;
  resetBidState();
  save();
  goAuctions();
  renderAll();
}

/* ---------- result overlay (driven by state.auction.lastResult) ---------- */
function showResultView(r) {
  const ov = $("#overlay"), title = $("#overlayTitle"), text = $("#overlayText"),
        logo = $("#overlayLogo"), actions = $("#overlayActions");
  ov.classList.remove("hidden");
  title.className = "overlay-title " + r.type;

  if (r.type === "sold") {
    title.textContent = "SOLD";
    const team = getTeam(r.teamId);
    logo.classList.remove("hidden");
    setPhoto(logo, team ? team.logo : "", initials(r.teamName));
    text.innerHTML = `<b>${esc(r.playerName)}</b> sold to <b>${esc(r.teamName)}</b> for <b>${money(r.price)}</b>`;
  } else {
    title.textContent = "UNSOLD";
    logo.classList.add("hidden");
    text.innerHTML = `<b>${esc(r.playerName)}</b> went unsold`;
  }
  actions.innerHTML = `<button class="btn btn-yellow" id="btnNextPlayer">Next Player ▶</button>`;
  const nb = $("#btnNextPlayer"); if (nb) nb.onclick = nextPlayer;
}
function hideOverlay() { $("#overlay").classList.add("hidden"); }
function overlayVisible() { return !$("#overlay").classList.contains("hidden"); }

/* ============================================================
   📊 AUCTION INSIGHTS (Phase E)
   Everything here is DERIVED from local `state` - no Firestore reads/writes.
   ============================================================ */
let insCharts = {};

function renderInsights() {
  const view = $("#subview-dashboard");
  if (!view) return;
  const teams = state.teams, players = state.players;
  const sold = players.filter(p => p.status === "sold" && !p.retained);
  const unsold = players.filter(p => p.status === "unsold");
  const available = players.filter(p => p.status === "available" && !p.retained);
  const auctionable = players.filter(p => !p.retained);
  const done = auctionable.filter(p => p.status !== "available").length;
  const completion = auctionable.length ? Math.round(done / auctionable.length * 100) : 0;
  const moneySpent = sold.reduce((a, p) => a + (p.soldPrice || 0), 0);
  const avgSale = sold.length ? moneySpent / sold.length : 0;
  const byPrice = sold.slice().sort((a, b) => (b.soldPrice || 0) - (a.soldPrice || 0));
  const mostExp = byPrice[0], cheapest = byPrice[byPrice.length - 1];
  const totalPurse = teams.reduce((a, t) => a + teamPurse(t), 0);
  const moneyRemaining = totalPurse - moneySpent;
  const teamSpends = teams.map(t => ({ t, spent: teamSpent(t.id), info: squadInfo(state, t.id) }))
    .sort((a, b) => b.spent - a.spent);
  const highSpend = teamSpends[0], lowSpend = teamSpends[teamSpends.length - 1];
  const avgPerTeam = teams.length ? moneySpent / teams.length : 0;
  const bidWar = sold.slice().sort((a, b) => (b.soldBids || 0) - (a.soldBids || 0))[0];
  const teamName = id => { const t = getTeam(id); return t ? esc(t.name) : "-"; };
  const card = (label, value, accent) =>
    `<div class="ins-card"><div class="ins-k">${label}</div><div class="ins-v${accent ? " accent" : ""}">${value}</div></div>`;

  view.innerHTML = `
    <div class="view-head"><h2>📊 AUCTION INSIGHTS</h2></div>
    <div class="ins-complete">
      <div class="ins-complete-top"><span>Auction Completion</span><span><b>${completion}%</b> · ${done} / ${auctionable.length} done</span></div>
      <div class="ins-bar"><span style="width:${completion}%"></span></div>
    </div>
    <div class="ins-cards">
      ${card("Most Expensive", mostExp ? `${esc(mostExp.name)} · ${money(mostExp.soldPrice)}` : "-", true)}
      ${card("Cheapest Sold", cheapest ? `${esc(cheapest.name)} · ${money(cheapest.soldPrice)}` : "-")}
      ${card("Average Sale", sold.length ? money(avgSale) : "-")}
      ${card("Players Sold", sold.length)}
      ${card("Players Unsold", unsold.length)}
      ${card("Remaining", available.length)}
      ${card("Money Spent", money(moneySpent), true)}
      ${card("Money Remaining", money(moneyRemaining))}
      ${card("Highest Team Spend", highSpend ? `${esc(highSpend.t.name)} · ${money(highSpend.spent)}` : "-")}
      ${card("Lowest Team Spend", lowSpend ? `${esc(lowSpend.t.name)} · ${money(lowSpend.spent)}` : "-")}
      ${card("Avg Spend / Team", money(avgPerTeam))}
      ${card("Biggest Bid War", (bidWar && bidWar.soldBids) ? `${esc(bidWar.name)} · ${bidWar.soldBids} bids` : "-", true)}
    </div>
    <div class="ins-charts">
      <div class="ins-chart"><h3>Price Distribution</h3><canvas id="chartPrices"></canvas></div>
      <div class="ins-chart"><h3>Sold vs Unsold</h3><canvas id="chartSold"></canvas></div>
      <div class="ins-chart"><h3>Team Spending</h3><canvas id="chartTeamSpend"></canvas></div>
      <div class="ins-chart"><h3>Remaining Purse</h3><canvas id="chartTeamPurse"></canvas></div>
    </div>
    <div class="ins-tables">
      <div class="ins-table"><h3>Top Sold Players</h3>
        <table><thead><tr><th>#</th><th>Player</th><th>Team</th><th class="num">Price</th></tr></thead><tbody>
          ${byPrice.slice(0, 10).map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.name)}</td><td>${teamName(p.soldTo)}</td><td class="num">${money(p.soldPrice)}</td></tr>`).join("") || `<tr><td colspan="4">No sales yet</td></tr>`}
        </tbody></table></div>
      <div class="ins-table"><h3>Team Analytics</h3>
        <table><thead><tr><th>Team</th><th class="num">Players</th><th class="num">Spent</th><th class="num">Spent %</th><th class="num">Safe Bid</th></tr></thead><tbody>
          ${teamSpends.map(({ t, spent, info }) => { const purse = teamPurse(t); const pct = purse ? Math.round(spent / purse * 100) : 0;
            return `<tr><td>${esc(t.name)}</td><td class="num">${info.squadCount}/${info.maxPlayers}</td><td class="num">${money(spent)}</td><td class="num">${pct}%</td><td class="num">${money(Math.max(0, info.safeBid))}</td></tr>`; }).join("") || `<tr><td colspan="5">No teams</td></tr>`}
        </tbody></table></div>
    </div>`;

  // Charts: only when the tab is visible and Chart.js actually loaded (offline-safe).
  if (view.classList.contains("active") && window.Chart) buildInsightCharts({ sold, unsold, available, byPrice, teamSpends });
}

function buildInsightCharts(d) {
  Object.values(insCharts).forEach(c => { try { c.destroy(); } catch (e) {} });
  insCharts = {};
  const gridC = "rgba(255,255,255,0.08)", tickC = "#9b9ba3";
  const axis = { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: tickC } } },
    scales: { x: { ticks: { color: tickC }, grid: { color: gridC } }, y: { ticks: { color: tickC }, grid: { color: gridC } } } };
  const pie = { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: tickC } } } };
  const mk = (id, cfg) => { const el = document.getElementById(id); if (el) insCharts[id] = new window.Chart(el, cfg); };

  const prices = d.sold.map(p => p.soldPrice || 0);
  const max = Math.max(1, ...prices), binCount = 6, binSize = Math.ceil(max / binCount) || 1;
  const bins = Array.from({ length: binCount }, () => 0);
  prices.forEach(v => { bins[Math.min(binCount - 1, Math.floor(v / binSize))]++; });
  mk("chartPrices", { type: "bar", data: { labels: bins.map((_, i) => `${i * binSize}-${(i + 1) * binSize}`),
    datasets: [{ label: "Players", data: bins, backgroundColor: "#ffcc00" }] }, options: axis });
  mk("chartSold", { type: "doughnut", data: { labels: ["Sold", "Unsold", "Remaining"],
    datasets: [{ data: [d.sold.length, d.unsold.length, d.available.length], backgroundColor: ["#22c55e", "#e10600", "#34343a"] }] }, options: pie });
  mk("chartTeamSpend", { type: "bar", data: { labels: d.teamSpends.map(x => x.t.name),
    datasets: [{ label: "Spent", data: d.teamSpends.map(x => x.spent), backgroundColor: "#e10600" }] }, options: axis });
  mk("chartTeamPurse", { type: "bar", data: { labels: d.teamSpends.map(x => x.t.name),
    datasets: [{ label: "Remaining", data: d.teamSpends.map(x => x.info.remaining), backgroundColor: "#22c55e" }] }, options: axis });
}

/* ---------- PLAYERS ---------- */
function renderPlayers() {
  const q = ($("#playerSearch").value || "").toLowerCase();
  const f = $("#playerFilter").value;
  const grid = $("#playersGrid");
  grid.innerHTML = "";
  const matchFilter = p =>
    f === "all" ? true :
    f === "retained" ? p.retained :
    f === "sold" ? (p.status === "sold" && !p.retained) :
    p.status === f;
  const list = state.players.filter(p => matchFilter(p) && p.name.toLowerCase().includes(q));

  if (!list.length) { grid.innerHTML = `<p class="hint">No players to show.</p>`; return; }

  list.forEach(p => {
    const team = p.soldTo ? getTeam(p.soldTo) : null;
    const badgeClass = p.retained ? `retained ${retainTagClass(p.role)}` : p.status;
    const badgeText = p.retained ? retainTag(p.role) : p.status;
    let foot;
    if (p.status === "available")    foot = `<button class="btn btn-yellow btn-mini" data-auction="${p.id}">Auction now</button>`;
    else if (p.status === "unsold")  foot = `<button class="btn btn-dark btn-mini" data-auction="${p.id}">Re-auction</button>`;
    else foot = `<span class="pcard-sold">${team ? esc(team.name) : "-"} · <b>${money(p.soldPrice)}</b></span>`;

    const card = document.createElement("div");
    card.className = "pcard";
    card.innerHTML = `
      <div class="pcard-photo" style="${p.photo ? `background-image:url('${p.photo}')` : ""}">${p.photo ? "" : esc(initials(p.name))}</div>
      <div class="pcard-body">
        <span class="pcard-name">${esc(p.name)}</span>
        ${(p.role && !p.retained) ? `<span class="pcard-role">${esc(p.role)}</span>` : ""}
        <span class="pcard-base">${p.retained ? (esc(retainLabel(p.role)) + (p.soldPrice ? " · " + money(p.soldPrice) : "")) : ("Base " + money(p.basePrice))}</span>
      </div>
      <div class="pcard-foot">
        <span class="badge ${badgeClass}">${esc(badgeText)}</span>
        ${p.rtmBy ? `<span class="ret-tag rt-rtm" title="Signed with a Right to Match card">RTM</span>` : ""}
        ${foot}
      </div>`;
    grid.appendChild(card);
  });
}

/* ---------- TEAMS & PURSE ---------- */
function renderPurse() {
  const grid = $("#purseGrid");
  grid.innerHTML = "";
  if (!state.teams.length) { grid.innerHTML = `<p class="hint">No teams yet. Add teams in the ⚙️ Setup tab.</p>`; return; }

  state.teams.forEach(t => {
    const total = teamPurse(t), spent = teamSpent(t.id), remaining = total - spent;
    const count = teamPlayers(t.id).length;
    const pct = total > 0 ? Math.min(100, (spent / total) * 100) : 0;
    const card = document.createElement("div");
    card.className = "purse-card";
    card.innerHTML = `
      <div class="purse-head">
        ${logoHTML("team-logo", t.logo, t.name)}
        <div>
          <div class="purse-name">${esc(t.name)}</div>
          <div class="purse-count">${count} player${count !== 1 ? "s" : ""}${
            rtmOn(state) && rtmCardsPerTeam(state) > 0
              ? (rtmLeft(state, t.id) > 0
                  ? `<i class="rtm-badge inline" title="Right to Match cards left">RTM ${rtmLeft(state, t.id)}/${rtmCardsPerTeam(state)}</i>`
                  : `<i class="rtm-badge inline spent" title="Right to Match card used">RTM used</i>`)
              : ""}</div>
        </div>
      </div>
      <div class="purse-amounts">
        <span class="muted">Spent ${money(spent)}</span>
        <span class="muted">Total ${money(total)}</span>
      </div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div style="margin-top:12px">
        <span style="color:var(--muted);font-size:11px;letter-spacing:2px">REMAINING</span>
        <div class="purse-remaining">${money(remaining)}</div>
      </div>`;
    grid.appendChild(card);
  });
}

/* ---------- SQUADS ---------- */
function renderSquads() {
  const grid = $("#squadsGrid");
  grid.innerHTML = "";
  if (!state.teams.length) { grid.innerHTML = `<p class="hint">No teams yet.</p>`; return; }

  state.teams.forEach(t => {
    const players = teamPlayers(t.id);
    const rows = players.length
      ? players.map(p => `
        <div class="squad-row">
          <span class="mini-photo" style="${p.photo ? `background-image:url('${p.photo}')` : ""}">${p.photo ? "" : esc(initials(p.name))}</span>
          <span class="sr-name">${esc(p.name)}</span>
          ${p.retained ? `<span class="ret-tag ${retainTagClass(p.role)}">${esc(retainTag(p.role))}</span>` : ""}
          ${p.rtmBy ? `<span class="ret-tag rt-rtm" title="Signed with a Right to Match card">RTM</span>` : ""}
          <span class="sr-price">${p.soldPrice ? money(p.soldPrice) : ""}</span>
        </div>`).join("")
      : `<div class="squad-empty">No players bought yet.</div>`;

    const card = document.createElement("div");
    card.className = "squad-card";
    card.innerHTML = `
      <div class="squad-head">
        ${logoHTML("team-logo lg", t.logo, t.name)}
        <div class="purse-name">${esc(t.name)}</div>
      </div>
      <div class="squad-meta">${players.length} players · spent ${money(teamSpent(t.id))} · ${money(teamRemaining(t))} left</div>
      <div class="squad-players">${rows}</div>`;
    grid.appendChild(card);
  });
}

/* ---------- SETUP ---------- */
// True when the VIEWED tournament runs without a player auction (fixed-squad).
// js/app.js:syncAuctionMode() keeps body.no-auction in step with HCCLSeries.
function noAuctionMode() { return document.body.classList.contains("no-auction"); }

function fillSettingsInputs() {
  $("#setSeasonName").value = state.settings.seasonName;
  $("#setSeasonNumber").value = state.settings.seasonNumber;
  $("#setCurrency").value = state.settings.currency;
  $("#setPurse").value = state.settings.defaultPurse;
  $("#setSquadSize").value = squadCapOf(state, null);
  $("#setIncrement").value = state.settings.bidIncrement;
  const en = $("#setRtmEnabled"); if (en) en.checked = state.settings.rtmEnabled !== false;
  const rc = $("#setRtmCards"); if (rc) rc.value = rtmCardsPerTeam(state);
  fillPrevTournamentSelect();
}

/* "Last season" picker - every OTHER tournament in the registry, newest first.
   Rebuilt only when the registry actually changes (the list arrives after this
   form is first drawn), and it keeps an in-progress pick the admin hasn't
   saved yet rather than resetting it on every render. */
function fillPrevTournamentSelect() {
  const sel = $("#setPrevTournament");
  if (!sel) return;
  const S = window.HCCLSeries;
  const list = (S && S.list) ? S.list().filter(t => t.id !== (S.viewingId && S.viewingId())) : [];
  const sig = list.map(t => t.id).join(",");
  if (sel.dataset.sig === sig && sel.options.length) return;   // already built for this list
  const want = sel.value || state.settings.prevTournamentId || "";
  sel.dataset.sig = sig;
  sel.innerHTML = `<option value="">- none -</option>` +
    list.slice().reverse().map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("");
  sel.value = want;
  if (sel.value !== want) sel.value = ""; // the stored one vanished from the registry
}

function renderSetup() {
  // A fixed-squad (non-auction) tournament hides purse/base-price and adds
  // players straight into a team, so the Setup lists read differently.
  const noAuction = noAuctionMode();
  fillPrevTournamentSelect();   // the tournament registry lands after app init
  if (!$("#pFormerTeam").options.length) fillFormerTeamSelect(null);

  // team list
  const tl = $("#teamMiniList");
  tl.innerHTML = "";
  if (!state.teams.length) tl.innerHTML = `<p class="hint">No teams added yet.</p>`;
  state.teams.forEach(t => {
    const row = document.createElement("div");
    row.className = "mini-row";
    const sub = noAuction ? `${teamCap(t)} players` : `${money(teamPurse(t))} · ${teamCap(t)} players`;
    row.innerHTML = `
      ${logoHTML("ml-logo", t.logo, t.name)}
      <span class="ml-name">${esc(t.name)}</span>
      <span class="ml-sub">${sub}</span>
      <button class="icon-btn" data-edit-team="${t.id}" title="Edit">✎</button>
      <button class="icon-btn del" data-del-team="${t.id}" title="Delete">✕</button>`;
    tl.appendChild(row);
  });

  // player list (retained players are managed separately, below). In auction
  // mode this is the auction queue (order + base price); in non-auction mode
  // it lists each player's squad + role, and the reorder arrows don't apply.
  const pl = $("#playerMiniList");
  pl.innerHTML = "";
  const queue = state.players.filter(p => !p.retained);
  if (!queue.length) pl.innerHTML = `<p class="hint">No players added yet.</p>`;
  queue.forEach(p => {
    const row = document.createElement("div");
    row.className = "mini-row";
    let sub, reorder;
    if (noAuction) {
      const t = getTeam(p.soldTo);
      sub = `${t ? esc(t.name) : "Unassigned"}${p.role ? " · " + esc(p.role) : ""}`;
      reorder = "";
    } else {
      sub = `${money(p.basePrice)} · ${p.status}`;
      reorder = `
      <button class="icon-btn" data-up="${p.id}" title="Move up">▲</button>
      <button class="icon-btn" data-down="${p.id}" title="Move down">▼</button>`;
    }
    row.innerHTML = `
      ${logoHTML("ml-logo", p.photo, p.name)}
      <span class="ml-name">${esc(p.name)}</span>
      <span class="ml-sub">${sub}</span>${reorder}
      <button class="icon-btn" data-edit-player="${p.id}" title="Edit">✎</button>
      <button class="icon-btn del" data-del-player="${p.id}" title="Delete">✕</button>`;
    pl.appendChild(row);
  });

  // Team dropdowns (preserve current selection) - #pTeam for the non-auction
  // Add Player form, #retainTeam for the auction retain form.
  const teamOpts = state.teams.length
    ? state.teams.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join("")
    : `<option value="">Add a team first</option>`;
  const pt = $("#pTeam");
  if (pt) { const curPt = pt.value; pt.innerHTML = teamOpts; if ([...pt.options].some(o => o.value === curPt)) pt.value = curPt; }
  const rt = $("#retainTeam");
  const cur = rt.value;
  rt.innerHTML = teamOpts;
  if ([...rt.options].some(o => o.value === cur)) rt.value = cur;

  // retained player list
  const rl = $("#retainMiniList");
  rl.innerHTML = "";
  const retained = state.players.filter(p => p.retained);
  if (!retained.length) rl.innerHTML = `<p class="hint">No retained players yet.</p>`;
  retained.forEach(p => {
    const team = getTeam(p.soldTo);
    const row = document.createElement("div");
    row.className = "mini-row";
    row.innerHTML = `
      ${logoHTML("ml-logo", p.photo, p.name)}
      <span class="ml-name">${esc(p.name)}</span>
      <span class="ret-tag ${retainTagClass(p.role)}">${esc(retainTag(p.role))}</span>
      <span class="ml-sub">${team ? esc(team.name) : "-"}${p.soldPrice ? " · " + money(p.soldPrice) : ""}</span>
      <button class="icon-btn" data-edit-retain="${p.id}" title="Edit">✎</button>
      <button class="icon-btn del" data-del-retain="${p.id}" title="Remove">✕</button>`;
    rl.appendChild(row);
  });
}

async function saveSettings() {
  const s = state.settings;
  s.seasonName = $("#setSeasonName").value.trim() || "HCCL";
  s.seasonNumber = parseInt($("#setSeasonNumber").value) || 1;
  s.currency = $("#setCurrency").value.trim() || "Cr";
  s.defaultPurse = parseFloat($("#setPurse").value) || 0;
  s.squadSize = Math.max(1, parseInt($("#setSquadSize").value) || DEFAULT_SQUAD_SIZE);
  s.bidIncrement = parseFloat($("#setIncrement").value) || 1;
  const en = $("#setRtmEnabled"); if (en) s.rtmEnabled = !!en.checked;
  const rc = $("#setRtmCards"); if (rc && rc.value !== "") s.rtmCards = Math.max(0, parseInt(rc.value) || 0);
  const pt = $("#setPrevTournament"); if (pt) s.prevTournamentId = pt.value || "";
  const f = $("#setLogoFile").files[0];
  if (f) { try { s.leagueLogo = await fileToDataURL(f, 220, "png"); } catch (e) { toast("Couldn't read logo image", "bad"); } }
  $("#setLogoFile").value = "";
  save();
  renderAll();
  toast("Settings saved", "good");
}

/* teams */
async function saveTeam() {
  const name = $("#teamName").value.trim();
  if (!name) { toast("Enter a team name", "bad"); return; }
  const purseVal = $("#teamPurse").value;
  const purse = purseVal === "" ? null : parseFloat(purseVal);
  const capVal = $("#teamMaxPlayers").value;                 // blank = use the league default
  const maxPlayers = capVal === "" ? null : Math.max(1, parseInt(capVal) || DEFAULT_SQUAD_SIZE);
  const f = $("#teamLogoFile").files[0];
  let logo = null;
  if (f) { try { logo = await fileToDataURL(f, 220, "png"); } catch (e) { toast("Couldn't read logo", "bad"); } }

  const editId = $("#teamEditId").value;
  if (editId) {
    const t = getTeam(editId);
    if (t) { t.name = name; t.purse = purse; t.maxPlayers = maxPlayers; if (logo) t.logo = logo; }
  } else {
    state.teams.push({ id: uid(), name, purse, maxPlayers, logo: logo || "" });
  }
  clearTeamForm();
  save();
  renderAll();
  publishTeamLogos(); // mirror the crest into the global registry for Rankings
  toast("Team saved", "good");
}
function editTeam(id) {
  const t = getTeam(id); if (!t) return;
  $("#teamEditId").value = t.id;
  $("#teamName").value = t.name;
  $("#teamPurse").value = t.purse ?? "";
  $("#teamMaxPlayers").value = t.maxPlayers ?? "";
  $("#teamFormTitle").textContent = "Edit Team";
  $("#btnSaveTeam").textContent = "Save Changes";
  $("#btnCancelTeam").classList.remove("hidden");
  switchTab("setup");
  $("#teamName").focus();
}
function clearTeamForm() {
  $("#teamEditId").value = ""; $("#teamName").value = ""; $("#teamPurse").value = "";
  $("#teamMaxPlayers").value = ""; $("#teamLogoFile").value = "";
  $("#teamFormTitle").textContent = "Add Team";
  $("#btnSaveTeam").textContent = "Add Team";
  $("#btnCancelTeam").classList.add("hidden");
}
function deleteTeam(id) {
  const t = getTeam(id); if (!t) return;
  const owned = teamPlayers(id);
  const retained = owned.filter(p => p.retained);
  const bought = owned.filter(p => !p.retained);
  let msg = `Delete team "${t.name}"?`;
  if (bought.length) msg += `\n\n${bought.length} auctioned player(s) will be returned to Available.`;
  if (retained.length) msg += `\n${retained.length} retained player(s) will be removed.`;
  if (!confirm(msg)) return;
  bought.forEach(p => { p.status = "available"; p.soldTo = null; p.soldPrice = null; });
  const retainedIds = new Set(retained.map(p => p.id));
  state.players = state.players.filter(p => !retainedIds.has(p.id));
  state.teams = state.teams.filter(x => x.id !== id);
  if (state.auction.currentBidderId === id) resetBidState();
  clearTeamForm();
  save();
  renderAll();
}

/* players */
async function savePlayer() {
  const name = $("#pName").value.trim();
  if (!name) { toast("Enter a player name", "bad"); return; }
  const noAuction = noAuctionMode();
  // Auction tournaments need a base price; fixed-squad ones need a team instead.
  const teamId = noAuction ? $("#pTeam").value : "";
  const base = noAuction ? 0 : parseFloat($("#pBase").value);
  if (noAuction) {
    if (!getTeam(teamId)) { toast("Add a team first, then pick it here", "bad"); return; }
  } else if (isNaN(base) || base < 0) {
    toast("Enter a valid base price", "bad"); return;
  }
  const role = $("#pRole").value.trim();
  const formerSel = $("#pFormerTeam");
  const formerTeamId = formerSel ? (formerSel.value || null) : undefined; // "" -> null (unset)
  const f = $("#pPhotoFile").files[0];
  let photo = null;
  if (f) { try { photo = await fileToDataURL(f, 460, "jpeg"); } catch (e) { toast("Couldn't read photo", "bad"); } }

  const editId = $("#playerEditId").value;
  const stats = readStatsForm();
  if (editId) {
    const p = getPlayer(editId);
    if (p) {
      p.name = name; p.role = role;
      if (noAuction) {
        // Fixed-squad: player belongs directly to a team (no auction, no price).
        p.status = "sold"; p.soldTo = teamId; p.soldPrice = null; p.basePrice = 0;
      } else {
        p.basePrice = base;
      }
      if (photo) p.photo = photo;
      if (formerTeamId !== undefined) p.formerTeamId = formerTeamId;
      if (stats) p.stats = stats; else delete p.stats;
    }
  } else if (noAuction) {
    // Not retained, so the squad shows its role (no RET tag) and no price.
    const np = { id: uid(), name, role, basePrice: 0, photo: photo || "", status: "sold", soldTo: teamId, soldPrice: null };
    if (stats) np.stats = stats;
    state.players.push(np);
  } else {
    const np = { id: uid(), name, role, basePrice: base, photo: photo || "", status: "available", soldTo: null, soldPrice: null,
                 formerTeamId: formerTeamId || null, rtmBy: null };
    if (stats) np.stats = stats;
    state.players.push(np);
  }
  clearPlayerForm();
  save();
  renderAll();
  toast("Player saved", "good");
}
function editPlayer(id) {
  const p = getPlayer(id); if (!p) return;
  $("#playerEditId").value = p.id;
  $("#pName").value = p.name;
  $("#pRole").value = p.role || "";
  $("#pBase").value = p.basePrice;
  if ($("#pTeam")) $("#pTeam").value = p.soldTo || "";
  fillFormerTeamSelect(p.formerTeamId);
  fillStatsForm(p.stats);
  $("#playerFormTitle").textContent = "Edit Player";
  $("#btnSavePlayer").textContent = "Save Changes";
  $("#btnCancelPlayer").classList.remove("hidden");
  switchTab("setup");
  $("#pName").focus();
}
function clearPlayerForm() {
  $("#playerEditId").value = ""; $("#pName").value = ""; $("#pRole").value = ""; $("#pBase").value = ""; $("#pPhotoFile").value = "";
  if ($("#pTeam")) $("#pTeam").value = "";
  fillFormerTeamSelect(null);
  fillStatsForm(null);
  careerPreviewFound = null;
  const cpBox = $("#playerStatsPreview");
  if (cpBox) { cpBox.classList.add("hidden"); cpBox.innerHTML = ""; }
  $("#playerFormTitle").textContent = "Add Player";
  $("#btnSavePlayer").textContent = "Add Player";
  $("#btnCancelPlayer").classList.add("hidden");
}

/* "Last season's team" picker on the player form. "" = unset, "none" = the admin
   said he had no franchise last season (so the linker won't touch him). */
function fillFormerTeamSelect(value) {
  const sel = $("#pFormerTeam");
  if (!sel) return;
  sel.innerHTML = `<option value="">- not set -</option><option value="none">- none (new player) -</option>` +
    state.teams.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("");
  sel.value = value || "";
  if (sel.value !== (value || "")) sel.value = ""; // stale team id
}

/* Read last season's squads and stamp formerTeamId on every player whose name
   matches. Names are matched case/space-insensitively; last season's TEAM name
   is matched to a team in THIS auction the same way. Players already set by
   hand (including "none") are left alone, and unmatched names are reported so
   the admin can fix them in the dropdown. */
async function linkFormerTeams() {
  if (!auCanEdit()) { toast("Only admins/moderators can do that", "bad"); return; }
  const out = $("#rtmLinkResult");
  const tid = ($("#setPrevTournament") || {}).value || "";
  if (!tid) { toast("Pick which tournament was last season first", "bad"); return; }
  const S = window.HCCLSeries;
  if (!S || typeof S.squadsOf !== "function") { toast("Tournament data unavailable", "bad"); return; }
  if (out) out.textContent = "Reading last season's squads…";
  let squads = [];
  try { squads = await S.squadsOf(tid); } catch (e) { console.error(e); }
  if (!squads || !squads.length) {
    if (out) out.textContent = "No squads found in that tournament.";
    toast("No squads found in that tournament", "bad");
    return;
  }
  const key = n => String(n || "").trim().toLowerCase().replace(/\s+/g, " ");
  const teamByKey = new Map(state.teams.map(t => [key(t.name), t.id]));
  const playerToTeamId = new Map();      // last-season player name -> THIS auction's team id
  const missingTeams = new Set();
  squads.forEach(g => {
    const id = teamByKey.get(key(g.team));
    if (!id) { missingTeams.add(g.team); return; }
    (g.players || []).forEach(n => playerToTeamId.set(key(n), id));
  });

  let set = 0, skipped = 0;
  const unmatched = [];
  state.players.forEach(p => {
    if (p.formerTeamId) { skipped++; return; }     // already set (or explicitly "none")
    const id = playerToTeamId.get(key(p.name));
    if (id) { p.formerTeamId = id; set++; } else unmatched.push(p.name);
  });
  save(); renderAll();

  const bits = [`Linked ${set} player${set === 1 ? "" : "s"}.`];
  if (skipped) bits.push(`${skipped} already set.`);
  if (unmatched.length) bits.push(`No match for: ${unmatched.slice(0, 8).join(", ")}${unmatched.length > 8 ? ` +${unmatched.length - 8} more` : ""}.`);
  if (missingTeams.size) bits.push(`Team name not in this auction: ${[...missingTeams].slice(0, 5).join(", ")}.`);
  if (out) out.textContent = bits.join(" ");
  toast(`Linked ${set} former team${set === 1 ? "" : "s"}`, set ? "good" : "bad");
}

/* ---------------- career-stats preview (Setup > Add Player) ----------------
   Type a name; if any past tournament sheet mentions them we show their career
   line and offer to fill the stat boxes. Nothing is written until Apply is
   tapped - the admin's own typing is never overwritten. */
let careerPreviewTimer = null;
let careerPreviewFound = null;   // the stats currently on offer
let careerExtraSheets = null;    // cloud-imported tournament CSVs, fetched once

// Cloud-imported sheets live at tournaments/{tid}/stats/sheet, which the archive
// can't see on its own. Pull them once so imported tournaments count too.
async function loadCareerExtraSheets() {
  if (careerExtraSheets) return careerExtraSheets;
  careerExtraSheets = [];
  const S = window.HCCLSeries, H = window.HCCL;
  if (!S || !S.list || !H || !H.configured || !H.user || !H.db || !H.fs || !H.fs.getDoc) return careerExtraSheets;
  try {
    const fs = H.fs;
    const list = S.list();
    const got = await Promise.all(list.map(t =>
      fs.getDoc(fs.doc(H.db, "tournaments", t.id, "stats", "sheet"))
        .then(d => (d.exists() ? { name: t.name, csv: (d.data() || {}).csv || "" } : null))
        .catch(() => null)));
    careerExtraSheets = got.filter(x => x && x.csv);
  } catch (e) { /* bundled sheets alone still give a useful career line */ }
  return careerExtraSheets;
}

function careerStatRow(k, v) {
  return `<div class="cp-item"><span class="cp-k">${esc(k)}</span><span class="cp-v">${esc(String(v))}</span></div>`;
}

async function renderCareerPreview() {
  const box = $("#playerStatsPreview");
  if (!box) return;
  const A = window.HCCLSeasonArchive;
  const name = ($("#pName") ? $("#pName").value : "").trim();
  careerPreviewFound = null;
  if (!A || !A.careerStatsFor || name.length < 3 || !auCanEdit()) {
    box.classList.add("hidden"); box.innerHTML = ""; return;
  }
  const extra = await loadCareerExtraSheets();
  const c = A.careerStatsFor(name, extra);
  if (!c) { box.classList.add("hidden"); box.innerHTML = ""; return; }

  // Previous price = what he actually sold for in the tournament marked as
  // "last season" (the same setting RTM uses).
  let prevPrice = null;
  const prevId = state.settings.prevTournamentId;
  if (prevId && window.HCCLSeries && window.HCCLSeries.lastAuctionPrices) {
    try {
      const prices = await window.HCCLSeries.lastAuctionPrices(prevId);
      const k = name.toLowerCase().replace(/\s+/g, " ");
      if (prices && prices[k] != null) prevPrice = prices[k];
    } catch (e) {}
  }
  careerPreviewFound = { ...c, previousPrice: prevPrice };

  const n = c.tournaments.length;
  box.classList.remove("hidden");
  box.innerHTML = `
    <div class="cp-head">
      <span class="cp-title">📊 Career stats found</span>
      <span class="cp-src" title="${esc(c.tournaments.join(", "))}">${n} tournament${n === 1 ? "" : "s"}</span>
    </div>
    <div class="cp-grid">
      ${careerStatRow("Matches", c.matches)}
      ${careerStatRow("Runs", c.runs)}
      ${careerStatRow("Wickets", c.wickets)}
      ${careerStatRow("Bat SR", c.strikeRate)}
      ${careerStatRow("Bat Avg", c.average)}
      ${careerStatRow("Economy", c.economy)}
      ${prevPrice != null ? careerStatRow("Prev Price", money(prevPrice)) : ""}
    </div>
    <div class="cp-actions">
      <button type="button" class="btn btn-yellow btn-mini" data-career-apply>Apply to form</button>
      <button type="button" class="btn btn-dark btn-mini" data-career-dismiss>Dismiss</button>
    </div>`;
}

// Fill the stat inputs from the offered career line (the only write path).
function applyCareerStats() {
  const c = careerPreviewFound;
  if (!c) return;
  const set = (id, v) => { const el = $("#" + id); if (el && v != null && v !== "") el.value = v; };
  set("pStatMatches", c.matches);
  set("pStatRuns", c.runs);
  set("pStatWickets", c.wickets);
  set("pStatSR", c.strikeRate);
  set("pStatAvg", c.average);
  set("pStatEcon", c.economy);
  if (c.previousPrice != null) set("pStatPrev", c.previousPrice);
  const det = $("#playerStatsPreview") ? document.querySelector(".stats-fieldset") : null;
  if (det && det.tagName === "DETAILS") det.open = true;   // show what just landed
  toast("Career stats applied", "good");
}

/* Optional player season stats (Phase E) - backwards compatible (omitted when blank). */
const STAT_FIELDS = [
  ["matches", "pStatMatches"], ["runs", "pStatRuns"], ["wickets", "pStatWickets"],
  ["strikeRate", "pStatSR"], ["economy", "pStatEcon"], ["average", "pStatAvg"],
  ["fantasyPoints", "pStatFP"], ["previousPrice", "pStatPrev"],
];
function readStatsForm() {
  const stats = {}; let any = false;
  STAT_FIELDS.forEach(([key, id]) => {
    const el = $("#" + id); if (!el) return;
    const v = el.value.trim();
    if (v !== "") { const n = Number(v); stats[key] = isNaN(n) ? v : n; any = true; }
  });
  return any ? stats : null;
}
function fillStatsForm(stats) {
  STAT_FIELDS.forEach(([key, id]) => { const el = $("#" + id); if (el) el.value = (stats && stats[key] != null) ? stats[key] : ""; });
}
function deletePlayer(id) {
  const p = getPlayer(id); if (!p) return;
  if (!confirm(`Delete player "${p.name}"?`)) return;
  state.players = state.players.filter(x => x.id !== id);
  if (state.auction.currentPlayerId === id) { state.auction.currentPlayerId = null; resetBidState(); }
  clearPlayerForm();
  save();
  renderAll();
}
function movePlayer(id, dir) {
  const queue = state.players.filter(p => !p.retained); // visible auction order
  const pos = queue.findIndex(p => p.id === id);
  const neighbor = queue[pos + dir];
  if (pos < 0 || !neighbor) return;
  const i = state.players.indexOf(queue[pos]);
  const j = state.players.indexOf(neighbor);
  [state.players[i], state.players[j]] = [state.players[j], state.players[i]];
  save();
  renderSetup();
  renderAuction();
}

/* retained / pre-assigned players */
async function saveRetain() {
  const teamId = $("#retainTeam").value;
  const team = getTeam(teamId);
  if (!team) { toast("Add a team first, then retain players", "bad"); return; }
  const name = $("#rName").value.trim();
  if (!name) { toast("Enter a player name", "bad"); return; }
  // Price is optional & informationalretained players carry over from last
  // season, so they are NOT deducted from this season's purse.
  const raw = $("#rPrice").value.trim();
  const price = raw === "" ? null : parseFloat(raw);
  if (price !== null && (isNaN(price) || price < 0)) { toast("Enter a valid price or leave it blank", "bad"); return; }

  const editId = $("#retainEditId").value;
  const current = editId ? getPlayer(editId) : null;
  const role = $("#rRole").value.trim();
  const f = $("#rPhotoFile").files[0];
  let photo = null;
  if (f) { try { photo = await fileToDataURL(f, 460, "jpeg"); } catch (e) { toast("Couldn't read photo", "bad"); } }

  if (current) {
    current.name = name; current.role = role; current.soldTo = teamId;
    current.rtmBy = null;   // retention isn't an RTM signing
    current.basePrice = price || 0; current.soldPrice = price;
    if (photo) current.photo = photo;
  } else {
    state.players.push({
      id: uid(), name, role, basePrice: price || 0, photo: photo || "",
      status: "sold", retained: true, soldTo: teamId, soldPrice: price, rtmBy: null,
    });
  }
  clearRetainForm();
  save();
  renderAll();
  toast("Retained player saved", "good");
}
// Select a category in the #rRole dropdown. A player saved before this list
// existed (or with a custom category) keeps their value: we inject it as an
// option so editing never silently drops it.
function setRetainRole(role) {
  const sel = $("#rRole");
  sel.querySelectorAll("option[data-custom]").forEach(o => o.remove());
  const val = role || "";
  if (val && ![...sel.options].some(o => o.value === val)) {
    const opt = document.createElement("option");
    opt.value = val; opt.textContent = val; opt.setAttribute("data-custom", "1");
    sel.appendChild(opt);
  }
  sel.value = val;
}
function editRetain(id) {
  const p = getPlayer(id); if (!p) return;
  $("#retainEditId").value = p.id;
  $("#retainTeam").value = p.soldTo || "";
  $("#rName").value = p.name;
  setRetainRole(p.role);
  $("#rPrice").value = p.soldPrice ?? "";
  $("#retainFormTitle").textContent = "Edit Retained Player";
  $("#btnSaveRetain").textContent = "Save Changes";
  $("#btnCancelRetain").classList.remove("hidden");
  switchTab("setup");
  $("#rName").focus();
}
function clearRetainForm() {
  $("#retainEditId").value = ""; $("#rName").value = ""; setRetainRole(""); $("#rPrice").value = ""; $("#rPhotoFile").value = "";
  $("#retainFormTitle").textContent = "Retain / Pre-assign Player";
  $("#btnSaveRetain").textContent = "Add Retained Player";
  $("#btnCancelRetain").classList.add("hidden");
}
function deleteRetain(id) {
  const p = getPlayer(id); if (!p) return;
  if (!confirm(`Remove retained player "${p.name}"?`)) return;
  state.players = state.players.filter(x => x.id !== id);
  clearRetainForm();
  save();
  renderAll();
}

/* data */
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const num = String(state.settings.seasonNumber).padStart(2, "0");
  a.href = url;
  a.download = `${(state.settings.seasonName || "hccl").toLowerCase()}-season-${num}-backup.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast("Backup downloaded", "good");
}
function importData(e) {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const data = JSON.parse(r.result);
      if (!Array.isArray(data.players) || !Array.isArray(data.teams)) throw new Error("bad");
      state = normalize(data);
      save();
      fillSettingsInputs();
      renderAll();
      toast("Backup imported", "good");
    } catch (err) { toast("Invalid backup file", "bad"); }
    e.target.value = "";
  };
  r.readAsText(f);
}
function loadSample() {
  if (state.teams.length || state.players.length) {
    if (!confirm("Replace current data with sample teams and players?")) return;
  }
  state = defaultState();
  const T = (name) => ({ id: uid(), name, purse: 100, logo: "" });
  state.teams = [T("Royal Strikers"), T("Thunder Kings"), T("Galle Gladiators"), T("Capital Chargers")];
  const P = (name, role, base) => ({ id: uid(), name, role, basePrice: base, photo: "", status: "available", soldTo: null, soldPrice: null });
  state.players = [
    P("Kasun Perera", "All-rounder", 2),
    P("Nuwan Silva", "Batsman", 1),
    P("Dinesh Fernando", "Fast bowler", 1.5),
    P("Sahan Jayasuriya", "Wicket-keeper", 1),
    P("Tharindu Bandara", "Spinner", 1),
    P("Ravindu Mendis", "Batsman", 2),
    P("Chamika Rajapaksa", "All-rounder", 1.5),
    P("Lahiru Gunaratne", "Fast bowler", 1),
  ];
  save();
  fillSettingsInputs();
  renderAll();
  goAuctions();
  toast("Sample data loaded", "good");
}
function reauctionUnsold() {
  const u = state.players.filter(p => p.status === "unsold");
  if (!u.length) { toast("No unsold players", "bad"); return; }
  u.forEach(p => { p.status = "available"; });
  save();
  renderAll();
  goAuctions();
  toast(`${u.length} player(s) re-opened`, "good");
}
function resetAuction() {
  const tn = window.HCCLSeries ? window.HCCLSeries.viewing().name : "this tournament";
  if (!confirm(`[${tn}] Reset all auction results?\n\nTeams and players stay (retained players are kept), but every auctioned player becomes Available and purses are restored.\n\nOnly this tournament is affected.`)) return;
  state.players.forEach(p => {
    if (p.retained) return; // keep pre-auction retentions
    p.status = "available"; p.soldTo = null; p.soldPrice = null;
    p.rtmBy = null;         // hand every Right-to-Match card back with the players
  });
  state.auction = { currentPlayerId: null, currentBid: 0, currentBidderId: null, soldStage: 0, bidLog: [], lastResult: null, rtm: null };
  state.lastAction = null;
  save();
  renderAll();
  toast("Auction reset", "good");
}
function resetAll() {
  const tn = window.HCCLSeries ? window.HCCLSeries.viewing().name : "this tournament";
  if (!confirm(`[${tn}] Erase EVERYTHING - teams, players and settings?\n\nOnly this tournament is affected.`)) return;
  if (!confirm("Are you absolutely sure? This cannot be undone.")) return;
  state = defaultState();
  save();
  fillSettingsInputs();
  renderAll();
  switchTab("setup");
  toast("All data erased", "good");
}

/* ============================================================
   EVENT WIRING
   ============================================================ */
function wireEvents() {
  // tabs
  $("#tabs").addEventListener("click", e => {
    const tab = e.target.closest(".tab");
    if (!tab) return;
    // Close FIRST: unlocking the page restores the scroll offset it was frozen
    // at, and switchTab's scroll-to-top has to be the one that wins.
    closeNav();
    switchTab(tab.dataset.tab);
    if (tab.dataset.tab === "auctions") switchSubTab("auction"); // land on Auction Room by default
    // SPA page_view on real user navigation only (the initial landing is covered
    // by Analytics' automatic first page_view - firing here too would duplicate it).
    if (window.HCCL) window.HCCL.trackPageView(tab.dataset.tab);
  });

  /* ---------------- mobile off-canvas nav drawer ----------------
     The drawer CANNOT live inside .app-header: the header has a
     backdrop-filter, which makes it the containing block for `position: fixed`
     descendants (a fixed child is then sized against the ~70px header, not the
     viewport - the "menu expands inside the navbar" bug), and `position: sticky`
     makes it a stacking context, which caps anything inside it at the header's
     own z-index. So below 900px we relocate the very same <nav id="tabs"> node
     to <body> - same element, same id, same listeners (fantasy.js, fixtures.js
     and series.js all hold references to it) - and hand it back to the header
     on desktop, where the layout is untouched. */
  const mq = window.matchMedia("(max-width: 900px)");
  const header = document.querySelector(".app-header");
  const nav = $("#tabs");
  const navToggle = $("#navToggle");
  const navClose = $("#navClose");
  const navBackdrop = $("#navBackdrop");
  const navSlot = document.createComment("tabs"); // marks the desktop home of the nav
  if (header && nav) header.insertBefore(navSlot, nav);

  let navReturnFocus = null; // control to hand focus back to when we close
  const navIsOpen = () => document.body.classList.contains("nav-open");

  // Freeze the page behind the drawer. The class goes on <html> ONLY - see the
  // measured comparison next to `html.nav-locked` in styles.css: the same
  // overflow:hidden on <body> makes the viewport clamp scrollY to 0, so the
  // page would silently jump to the top and lose the reader's place.
  const lockPage = on => document.documentElement.classList.toggle("nav-locked", on);

  function placeNav() {
    if (!header || !nav) return;
    if (mq.matches) {
      if (nav.parentElement !== document.body) document.body.appendChild(nav);
      // Only a drawer is a dialog; the desktop pill row is just a nav.
      nav.setAttribute("role", "dialog");
      nav.setAttribute("aria-modal", "true");
      nav.setAttribute("aria-labelledby", "navTitle");
    } else {
      closeNav({ restoreFocus: false }); // never leave a drawer open across the breakpoint
      if (nav.parentElement !== header) header.insertBefore(nav, navSlot);
      nav.removeAttribute("role");
      nav.removeAttribute("aria-modal");
      nav.removeAttribute("aria-labelledby");
    }
  }

  function openNav() {
    if (navIsOpen() || !mq.matches) return;
    navReturnFocus = document.activeElement;
    document.body.classList.add("nav-open");
    lockPage(true);
    if (navToggle) {
      navToggle.setAttribute("aria-expanded", "true");
      navToggle.setAttribute("aria-label", "Close menu");
    }
    if (navClose) navClose.focus(); // land the keyboard INSIDE the drawer
  }

  function closeNav(opts) {
    if (!navIsOpen()) return;
    document.body.classList.remove("nav-open");
    lockPage(false);
    if (navToggle) {
      navToggle.setAttribute("aria-expanded", "false");
      navToggle.setAttribute("aria-label", "Open menu");
    }
    // Focus returns to whatever opened the drawer (the hamburger), so keyboard
    // users aren't dumped at the top of the document.
    if (!opts || opts.restoreFocus !== false) {
      const back = (navReturnFocus && document.contains(navReturnFocus)) ? navReturnFocus : navToggle;
      if (back && back.focus) back.focus();
    }
    navReturnFocus = null;
  }

  // Tab must not walk out of an open drawer (aria-modal only tells AT that the
  // rest is inert - it doesn't move focus).
  function trapNavFocus(e) {
    if (e.key !== "Tab" || !navIsOpen() || !nav) return;
    const items = Array.from(nav.querySelectorAll("button"))
      .filter(b => !b.disabled && b.offsetParent !== null); // skips role-hidden tabs (e.g. Setup)
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  if (navToggle) navToggle.addEventListener("click", () => (navIsOpen() ? closeNav() : openNav()));
  if (navClose) navClose.addEventListener("click", () => closeNav());
  if (navBackdrop) navBackdrop.addEventListener("click", () => closeNav());
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") closeNav();
    else trapNavFocus(e);
  });
  mq.addEventListener("change", placeNav);
  placeNav();
  // Sub-tab bars - the Auction and Rankings sections share the same
  // .subtab pattern; switchSubTab scopes the toggle to the right section.
  document.addEventListener("click", e => {
    const st = e.target.closest(".subtab");
    if (st) switchSubTab(st.dataset.subtab);
  });

  // any [data-goto] button (empty state, overlay)
  document.addEventListener("click", e => {
    const g = e.target.closest("[data-goto]");
    if (g) { hideOverlay(); switchTab(g.dataset.goto); if (window.HCCL) window.HCCL.trackPageView(g.dataset.goto); }
  });

  // RTM handshake buttons (delegated - the panel is re-rendered constantly).
  const rtmBox = $("#rtmPanel");
  if (rtmBox) rtmBox.addEventListener("click", e => {
    const b = e.target.closest("[data-rtm]");
    if (!b) return;
    const act = b.getAttribute("data-rtm");
    if (act === "use") rtmUse();
    else if (act === "pass") rtmPass();
    else if (act === "cancel") rtmCancel();
  });

  // auctioneer controls
  $("#btnSold").onclick = advanceSold;
  $("#btnUnsold").onclick = markUnsold;
  $("#btnUndo").onclick = undoLast;
  $("#btnReset").onclick = resetBid;

  // Career-stats preview: debounce the name box, then Apply/Dismiss.
  const pn = $("#pName");
  if (pn) pn.addEventListener("input", () => {
    clearTimeout(careerPreviewTimer);
    careerPreviewTimer = setTimeout(() => { renderCareerPreview(); }, 400);
  });
  const cp = $("#playerStatsPreview");
  if (cp) cp.addEventListener("click", e => {
    if (e.target.closest("[data-career-apply]")) { applyCareerStats(); return; }
    if (e.target.closest("[data-career-dismiss]")) {
      careerPreviewFound = null; cp.classList.add("hidden"); cp.innerHTML = "";
    }
  });

  // settings
  $("#btnSaveSettings").onclick = saveSettings;
  const lk = $("#btnLinkFormerTeams"); if (lk) lk.onclick = linkFormerTeams;

  // team form
  $("#btnSaveTeam").onclick = saveTeam;
  $("#btnCancelTeam").onclick = clearTeamForm;

  // player form
  $("#btnSavePlayer").onclick = savePlayer;
  $("#btnCancelPlayer").onclick = clearPlayerForm;

  // retain form
  $("#btnSaveRetain").onclick = saveRetain;
  $("#btnCancelRetain").onclick = clearRetainForm;

  // data
  $("#btnExport").onclick = exportData;
  $("#importFile").onchange = importData;
  $("#btnLoadSample").onclick = loadSample;
  $("#btnReauction").onclick = reauctionUnsold;
  $("#btnResetAuction").onclick = resetAuction;
  $("#btnResetAll").onclick = resetAll;
  const cloudBtn = $("#btnCloudUpload"); if (cloudBtn) cloudBtn.onclick = uploadAuctionToCloud;

  // When an editor finishes typing, flush any remote update we held back.
  document.addEventListener("focusout", () => {
    if (!auPendingRender) return;
    setTimeout(() => {
      const ae = document.activeElement;
      if (ae && ["INPUT", "SELECT", "TEXTAREA"].includes(ae.tagName)) return; // still editing
      auPendingRender = false; ensureCurrentPlayer(); fillSettingsInputs(); renderAll();
    }, 0);
  });

  // players search / filter
  $("#playerSearch").oninput = renderPlayers;
  $("#playerFilter").onchange = renderPlayers;

  // delegated: players grid "auction now"
  $("#playersGrid").addEventListener("click", e => {
    const b = e.target.closest("[data-auction]");
    if (b) auctionNow(b.dataset.auction);
  });

  // delegated: team mini list
  $("#teamMiniList").addEventListener("click", e => {
    const ed = e.target.closest("[data-edit-team]");
    const del = e.target.closest("[data-del-team]");
    if (ed) editTeam(ed.dataset.editTeam);
    else if (del) deleteTeam(del.dataset.delTeam);
  });

  // delegated: player mini list
  $("#playerMiniList").addEventListener("click", e => {
    const up = e.target.closest("[data-up]");
    const down = e.target.closest("[data-down]");
    const ed = e.target.closest("[data-edit-player]");
    const del = e.target.closest("[data-del-player]");
    if (up) movePlayer(up.dataset.up, -1);
    else if (down) movePlayer(down.dataset.down, +1);
    else if (ed) editPlayer(ed.dataset.editPlayer);
    else if (del) deletePlayer(del.dataset.delPlayer);
  });

  // delegated: retained player list
  $("#retainMiniList").addEventListener("click", e => {
    const ed = e.target.closest("[data-edit-retain]");
    const del = e.target.closest("[data-del-retain]");
    if (ed) editRetain(ed.dataset.editRetain);
    else if (del) deleteRetain(del.dataset.delRetain);
  });

  // keyboard shortcuts (auction tab only)
  document.addEventListener("keydown", e => {
    if (["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) return;
    // Viewers can't drive the auction by keyboard either.
    if (window.HCCL && window.HCCL.configured && !window.HCCL.canEdit()) return;
    if (overlayVisible()) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); nextPlayer(); }
      return;
    }
    if (!$("#subview-auction").classList.contains("active")) return;
    if (e.key >= "1" && e.key <= "9") {
      const t = state.teams[+e.key - 1];
      if (t) placeBid(t.id);
    } else if (e.key === " ") {
      e.preventDefault(); advanceSold();
    } else if (e.key.toLowerCase() === "u") {
      markUnsold();
    } else if (e.key.toLowerCase() === "n") {
      nextPlayer();
    } else if (e.key.toLowerCase() === "z") {
      undoLast();
    }
  });
}

/* ============================================================
   INIT
   ============================================================ */
/* Start the cloud sync once BOTH auth (HCCL) and the tournament registry
   (HCCLSeries) are ready - the registry decides which paths to subscribe to. */
function auMaybeStartSync() {
  const H = window.HCCL, S = window.HCCLSeries;
  if (!H || !H.configured || !H.user || auUsingFirestore || auFellBack || !auDb() || !auApi()) return;
  if (S && !S.ready) return; // wait for the tournament registry
  auTid = S ? S.viewingId() : null;
  auUsingFirestore = true;
  startAuctionSync();
}

/* The viewed tournament changed: drop the old listeners, blank the board,
   and resubscribe under the new tournament's paths. */
// Reflect whether the VIEWED tournament runs an auction. Toggles body.no-auction,
// which hides the Auctions tab + every purse / base-price field (see styles.css).
function syncAuctionMode() {
  const has = !window.HCCLSeries || window.HCCLSeries.hasAuction();
  document.body.classList.toggle("no-auction", !has);
  // The tournament registry lands after app init - refresh the RTM "last season"
  // picker here, the one hook that fires in BOTH offline and cloud modes.
  fillPrevTournamentSelect();
  // Don't strand the user on a now-hidden Auctions tab.
  if (!has) { const av = $("#view-auctions"); if (av && av.classList.contains("active")) switchTab("series"); }
}

function auOnSeriesChange(S) {
  if (!S.ready) return;
  syncAuctionMode();
  const tid = S.viewingId();
  if (!auUsingFirestore) { auMaybeStartSync(); return; }
  if (tid === auTid) return;
  auTid = tid;
  auGen++; // disarm any pending watchdog / retry from the old subscriptions
  auUnsubs.splice(0).forEach(u => { try { u(); } catch (e) {} });
  auFsReady = false; auFsLoaded.clear(); auFellBack = false;
  auImgStarted = false; auImgLoaded.clear();
  auRetries = 0; auSlow = false;
  auMirror.teams = []; auMirror.players = []; auMirror.settings = null; auMirror.live = null;
  auImg.playerPhotos = new Map(); auImg.teamLogos = new Map();
  state = normalize(null); // blank while the new tournament streams in
  fillSettingsInputs(); renderAll(); updateCloudUploadBtn();
  startAuctionSync();
}

function init() {
  wireEvents();
  fillSettingsInputs();
  ensureCurrentPlayer();
  save();
  renderAll();
  // Real-time auction (Phase D): start syncing once SIGNED IN (reads require auth).
  let wasSignedIn = false;
  if (window.HCCL && typeof window.HCCL.onChange === "function") {
    window.HCCL.onChange(H => {
      auMaybeStartSync();
      // On the just-signed-in edge, land the user on the Home page.
      if (H.configured && H.user && !wasSignedIn) switchTab("home");
      wasSignedIn = !!(H.configured && H.user);
      // If the role drops to viewer while Setup is open, kick back to Home.
      const setupView = $("#view-setup");
      if (!auCanEdit() && setupView && setupView.classList.contains("active")) switchTab("home");
      renderAll(); updateCloudUploadBtn(); // re-render so gating applies live
    });
  }
  // Tournament switching (js/series.js) - resubscribe when the viewed one changes.
  if (window.HCCLSeries) window.HCCLSeries.onChange(auOnSeriesChange);
  // Network / tab came back: retry the cloud instead of waiting for a reload.
  if (window.HCCLSync) window.HCCLSync.onReconnect(auRetrySync);
  syncAuctionMode();
}
// Defer to DOMContentLoaded so the firebase-init.js MODULE (deferred) has already run
// and exposed window.HCCL - otherwise the onChange hook above never registers and the
// auction never syncs to Firestore. (fantasy.js does the same; that's why it works.)
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
