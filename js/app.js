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
    },
    teams: [],   // { id, name, logo, purse, maxPlayers }
    players: [], // { id, name, role, basePrice, photo, status, soldTo, soldPrice }
    auction: { currentPlayerId: null, currentBid: 0, currentBidderId: null, soldStage: 0, bidLog: [], lastResult: null },
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
   FIRESTORE REAL-TIME SYNC (Phase D)
   When Firebase is configured AND signed in, auction data lives in Firestore:
     auction/league/teams/{id}, auction/league/players/{id},
     auction/league/state/settings, auction/league/state/live.
   onSnapshot mirrors it into `state`; local edits (save) push a minimal diff.
   With no Firebase (or if unreachable) we stay on localStorage, as before.
   ============================================================ */
const AU_COLLS = ["teams", "players"];
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
}
// Build set/delete ops for an image collection by comparing current images to the mirror.
function auDiffImages(coll, items, getImg, ops) {
  const map = auImg[coll];
  const curIds = new Set(items.map(x => x.id));
  items.forEach(x => {
    const img = getImg(x) || "";
    if (img && map.get(x.id) !== img) ops.push({ t: "set", ref: auItemRef(coll, x.id), data: { data: img } });
    else if (!img && map.has(x.id)) ops.push({ t: "del", ref: auItemRef(coll, x.id) });
  });
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
    retained: !!d.retained, order: d.order || 0 };
  if (d.soldBids != null) p.soldBids = d.soldBids; // optional (Phase E)
  if (d.stats) p.stats = d.stats;                  // optional season stats (Phase E)
  return p;
}
const auDropOrder = x => { const c = { ...x }; delete c.order; return c; };

function startAuctionSync() {
  const api = auApi();
  auUnsubs.push(api.onSnapshot(auCollRef("teams"),
    snap => { const items = snap.docs.map(s => auNormTeam(s.id, s.data())).sort((a, b) => a.order - b.order);
      auMirror.teams = auClone(items); state.teams = items.map(auDropOrder); auApplyImages(); auLoaded("teams"); }, auErr));
  auUnsubs.push(api.onSnapshot(auCollRef("players"),
    snap => { const items = snap.docs.map(s => auNormPlayer(s.id, s.data())).sort((a, b) => a.order - b.order);
      auMirror.players = auClone(items); state.players = items.map(auDropOrder); auApplyImages(); auLoaded("players"); }, auErr));
  auUnsubs.push(api.onSnapshot(auCollRef("playerPhotos"),
    snap => { auImg.playerPhotos = new Map(snap.docs.map(s => [s.id, s.data().data || ""]));
      auApplyImages(); auLoaded("playerPhotos"); }, auErr));
  auUnsubs.push(api.onSnapshot(auCollRef("teamLogos"),
    snap => { auImg.teamLogos = new Map(snap.docs.map(s => [s.id, s.data().data || ""]));
      auApplyImages(); auLoaded("teamLogos"); }, auErr));
  auUnsubs.push(api.onSnapshot(auStateRef("settings"),
    snap => { if (snap.exists()) { auMirror.settings = auClone(snap.data()); state.settings = { ...defaultState().settings, ...snap.data() }; }
      else auMirror.settings = null; auLoaded("settings"); }, auErr));
  auUnsubs.push(api.onSnapshot(auStateRef("live"),
    snap => { if (snap.exists()) { const d = snap.data(); auMirror.live = auClone(d);
        state.auction = { ...defaultState().auction, ...(d.auction || {}) };
        if (!Array.isArray(state.auction.bidLog)) state.auction.bidLog = [];
        state.lastAction = d.lastAction || null; }
      else auMirror.live = null; auLoaded("live"); }, auErr));
  // Generation-tagged so a timer armed before a tournament switch can't
  // trigger a bogus fallback against the NEW subscriptions.
  const gen = ++auGen;
  setTimeout(() => { if (gen === auGen) auFallback("Live sync unavailable - this device only"); }, 6000);
}
function auLoaded(which) {
  auFsLoaded.add(which);
  if (!auFsReady && auFsLoaded.size === 6) auFsReady = true;
  auRemote();
}
function auErr(err) {
  console.error("auction snapshot error:", err);
  const code = err && err.code;
  auFallback(code === "permission-denied" ? "Cloud blocked: publish the latest Firestore rules"
    : code === "not-found" ? "Firestore database not created yet"
    : "Live sync unavailable - this device only");
}
function auFallback(msg) {
  if (auFellBack || auFsReady) return;
  auFellBack = true;
  auUnsubs.splice(0).forEach(u => { try { u(); } catch (e) {} });
  auUsingFirestore = false;
  // The local backup only holds the LEGACY tournament - never show it while
  // another tournament is being viewed.
  state = (!window.HCCLSeries || window.HCCLSeries.isLegacy()) ? normalize(load()) : normalize(null);
  toast(msg, "bad");
  fillSettingsInputs(); renderAll(); updateCloudUploadBtn();
}
function auRemote() {
  updateCloudUploadBtn();
  const ae = document.activeElement;
  if (ae && ["INPUT", "SELECT", "TEXTAREA"].includes(ae.tagName)) { auPendingRender = true; return; }
  ensureCurrentPlayer();
  fillSettingsInputs(); renderAll();
}

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
    auDiffImages("playerPhotos", state.players, p => p.photo, imgOps);
    auDiffImages("teamLogos",   state.teams,   t => t.logo,  imgOps);
    for (let i = 0; i < ops.length; i += 50) {   // text docs are light
      const batch = api.writeBatch(auDb());
      ops.slice(i, i + 50).forEach(op => op.t === "set" ? batch.set(op.ref, op.data) : batch.delete(op.ref));
      await batch.commit();
    }
    for (let i = 0; i < imgOps.length; i += 6) {  // images are big - tiny batches stay under the request-size cap
      const batch = api.writeBatch(auDb());
      imgOps.slice(i, i + 6).forEach(op => op.t === "set" ? batch.set(op.ref, op.data) : batch.delete(op.ref));
      await batch.commit();
    }
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

/* Point the browser-tab icon at the league logo (data URL). No-op if no logo. */
function setFavicon(href) {
  if (!href) return;
  let link = document.querySelector('link[rel="icon"]');
  if (!link) { link = document.createElement("link"); link.rel = "icon"; document.head.appendChild(link); }
  link.href = href;
}

let toastTimer;
function toast(msg, kind = "") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2400);
}

/* ============================================================
   TABS
   ============================================================ */
/* Old top-level tab names -> their new home after the nav regrouping
   (Squads lives under Auction; MVP + Player Ranking under Rankings).
   Keeps every legacy switchTab()/[data-goto] call working. */
const TAB_ALIASES = {
  squads:  { tab: "auctions", sub: "squads" },
  mvp:     { tab: "rankings", sub: "mvp" },
  ranking: { tab: "rankings", sub: "ranking" },
};

function switchTab(name) {
  const alias = TAB_ALIASES[name];
  if (alias) { switchTab(alias.tab); switchSubTab(alias.sub); return; }
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
  // Sibling modules (fixtures.js) read teams/squads through window.HCCLAuction;
  // this tells them the underlying data just changed (cloud snapshot, edit, …).
  document.dispatchEvent(new CustomEvent("hccl:data"));
}

/* Read-only view of the auction data for sibling modules. Keeps them decoupled
   from `state` while still resolving squads from the SAME teams/players the
   auction owns - in both cloud and localStorage mode. */
window.HCCLAuction = {
  teams:    () => state.teams.map(t => ({ id: t.id, name: t.name, logo: t.logo || "" })),
  squad:    id => teamPlayers(id).map(p => ({ id: p.id, name: p.name, role: p.role || "", photo: p.photo || "", retained: !!p.retained })),
  team:     id => { const t = getTeam(id); return t ? { id: t.id, name: t.name, logo: t.logo || "" } : null; },
  settings: () => ({ ...state.settings }),
};

function renderHeader() {
  const { seasonName, seasonNumber, leagueLogo } = state.settings;
  const num = String(seasonNumber).padStart(2, "0");
  $("#seasonTitle").textContent = `${seasonName} Season ${num}`;
  document.title = `${seasonName} Season ${num}`;
  setPhoto($("#brandLogo"), leagueLogo, initials(seasonName));
  setFavicon(leagueLogo);
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
  maybeAnnounceComplete();
  const player = currentPlayer();
  const stage = $("#auctionStage");
  const empty = $("#auctionEmpty");

  if (!player) {
    stage.classList.add("hidden");
    empty.classList.remove("hidden");
    if (state.players.length === 0) {
      empty.innerHTML = `<h2>No players to auction yet</h2>
        <p>Go to the <strong>⚙️ Setup</strong> tab to add teams and players, or load the sample data to try it out.</p>
        <button class="btn btn-yellow" data-goto="setup">Open Setup</button>`;
    } else {
      const sold = state.players.filter(p => p.status === "sold").length;
      const unsold = state.players.filter(p => p.status === "unsold").length;
      empty.innerHTML = `<h2>🏆 Auction Complete</h2>
        <p>${sold} sold · ${unsold} unsold.</p>
        <div class="form-row" style="justify-content:center">
          ${unsold ? `<button class="btn btn-yellow" id="btnReauction2">Re-open ${unsold} unsold</button>` : ""}
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
  box.innerHTML = `<div class="ss-title">Previous Season Stats</div><div class="ss-grid">
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
        <span class="tb-purse">${leading ? "★ Leading" : money(info.remaining) + " left"}</span>
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
        <div class="tc-players">${info.squadCount} / ${info.maxPlayers} Players</div>
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


/* Fire a one-time confetti + sound the moment the auction finishes (every player
   resolved). Resets if the auction is re-opened. Stays quiet on initial page load. */
let auCompleteState = null;
function maybeAnnounceComplete() {
  const hasAny = state.players.some(p => !p.retained);
  const hasAvailable = state.players.some(p => p.status === "available" && !p.retained);
  const complete = hasAny && !hasAvailable;
  if (auCompleteState === null) { auCompleteState = complete; return; } // baseline - no fanfare on load
  if (complete && !auCompleteState) burstConfetti();
  auCompleteState = complete;
}

/* Tiny dependency-free confetti burst. */
function burstConfetti() {
  let cv = $("#confettiCanvas");
  if (!cv) { cv = document.createElement("canvas"); cv.id = "confettiCanvas"; cv.className = "confetti-canvas"; document.body.appendChild(cv); }
  const ctx = cv.getContext("2d");
  cv.width = window.innerWidth; cv.height = window.innerHeight; cv.style.display = "block";
  const colors = ["#ffcc00", "#e10600", "#22c55e", "#ffffff", "#f5b301"];
  const pieces = Array.from({ length: 150 }, () => ({
    x: Math.random() * cv.width, y: -20 - Math.random() * cv.height * 0.3,
    r: 4 + Math.random() * 6, c: colors[(Math.random() * colors.length) | 0],
    vx: -2 + Math.random() * 4, vy: 2 + Math.random() * 4, rot: Math.random() * 6.28, vr: -0.2 + Math.random() * 0.4,
  }));
  const start = performance.now();
  (function frame(now) {
    const t = now - start;
    ctx.clearRect(0, 0, cv.width, cv.height);
    pieces.forEach(p => {
      p.x += p.vx; p.y += p.vy; p.vy += 0.05; p.rot += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.c;
      ctx.fillRect(-p.r / 2, -p.r / 2, p.r, p.r * 0.6); ctx.restore();
    });
    if (t < 2600) requestAnimationFrame(frame);
    else { ctx.clearRect(0, 0, cv.width, cv.height); cv.style.display = "none"; }
  })(start);
}

function renderSoldButton() {
  const btn = $("#btnSold");
  const a = state.auction;
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
  if (a.currentBidderId == null) { toast("No bids yetuse Unsold instead", "bad"); return; }
  if (a.soldStage < 3) { a.soldStage++; save(); renderSoldButton(); }
  else { finalizeSold(); }
}

function finalizeSold() {
  const player = currentPlayer();
  const a = state.auction;
  const team = getTeam(a.currentBidderId);
  if (!player || !team) return;
  const price = a.currentBid;
  player.status = "sold";
  player.soldTo = team.id;
  player.soldPrice = price;
  player.soldBids = (a.bidLog || []).length; // bid count, for the Insights "Biggest Bid War"
  state.lastAction = { type: "sold", playerId: player.id };
  a.lastResult = { type: "sold", playerId: player.id, playerName: player.name, teamId: team.id, teamName: team.name, price };
  resetBidState();
  save();
  renderAll();
}

function markUnsold() {  const player = currentPlayer();
  if (!player) return;
  player.status = "unsold";
  player.soldTo = null;
  player.soldPrice = null;
  state.lastAction = { type: "unsold", playerId: player.id };
  state.auction.lastResult = { type: "unsold", playerId: player.id, playerName: player.name };
  resetBidState();
  save();
  renderAll();
}

function nextPlayer() {  const a = state.auction;
  a.lastResult = null;
  const next = state.players.find(p => p.status === "available");
  a.currentPlayerId = next ? next.id : null;
  resetBidState();
  save();
  renderAll();
}

function resetBid() {  resetBidState();
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
    state.auction.currentPlayerId = player.id; // bring them back to the block
  }
  state.lastAction = null;
  state.auction.lastResult = null;
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
    const tag = p.retained ? "retained" : p.status;
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
        ${p.role ? `<span class="pcard-role">${esc(p.role)}</span>` : ""}
        <span class="pcard-base">${p.retained ? ("Retained" + (p.soldPrice ? " · " + money(p.soldPrice) : "")) : ("Base " + money(p.basePrice))}</span>
      </div>
      <div class="pcard-foot">
        <span class="badge ${tag}">${tag}</span>
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
          <div class="purse-count">${count} player${count !== 1 ? "s" : ""}</div>
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
          ${p.retained ? `<span class="ret-tag">RET</span>` : ""}
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
function fillSettingsInputs() {
  $("#setSeasonName").value = state.settings.seasonName;
  $("#setSeasonNumber").value = state.settings.seasonNumber;
  $("#setCurrency").value = state.settings.currency;
  $("#setPurse").value = state.settings.defaultPurse;
  $("#setSquadSize").value = squadCapOf(state, null);
  $("#setIncrement").value = state.settings.bidIncrement;
}

function renderSetup() {
  // team list
  const tl = $("#teamMiniList");
  tl.innerHTML = "";
  if (!state.teams.length) tl.innerHTML = `<p class="hint">No teams added yet.</p>`;
  state.teams.forEach(t => {
    const row = document.createElement("div");
    row.className = "mini-row";
    row.innerHTML = `
      ${logoHTML("ml-logo", t.logo, t.name)}
      <span class="ml-name">${esc(t.name)}</span>
      <span class="ml-sub">${money(teamPurse(t))} · ${teamCap(t)} players</span>
      <button class="icon-btn" data-edit-team="${t.id}" title="Edit">✎</button>
      <button class="icon-btn del" data-del-team="${t.id}" title="Delete">✕</button>`;
    tl.appendChild(row);
  });

  // auction player list (retained players are managed separately, below)
  const pl = $("#playerMiniList");
  pl.innerHTML = "";
  const queue = state.players.filter(p => !p.retained);
  if (!queue.length) pl.innerHTML = `<p class="hint">No players added yet.</p>`;
  queue.forEach(p => {
    const row = document.createElement("div");
    row.className = "mini-row";
    row.innerHTML = `
      ${logoHTML("ml-logo", p.photo, p.name)}
      <span class="ml-name">${esc(p.name)}</span>
      <span class="ml-sub">${money(p.basePrice)} · ${p.status}</span>
      <button class="icon-btn" data-up="${p.id}" title="Move up">▲</button>
      <button class="icon-btn" data-down="${p.id}" title="Move down">▼</button>
      <button class="icon-btn" data-edit-player="${p.id}" title="Edit">✎</button>
      <button class="icon-btn del" data-del-player="${p.id}" title="Delete">✕</button>`;
    pl.appendChild(row);
  });

  // retained team dropdown (preserve current selection)
  const rt = $("#retainTeam");
  const cur = rt.value;
  rt.innerHTML = state.teams.length
    ? state.teams.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join("")
    : `<option value="">Add a team first</option>`;
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
  const base = parseFloat($("#pBase").value);
  if (isNaN(base) || base < 0) { toast("Enter a valid base price", "bad"); return; }
  const role = $("#pRole").value.trim();
  const f = $("#pPhotoFile").files[0];
  let photo = null;
  if (f) { try { photo = await fileToDataURL(f, 460, "jpeg"); } catch (e) { toast("Couldn't read photo", "bad"); } }

  const editId = $("#playerEditId").value;
  const stats = readStatsForm();
  if (editId) {
    const p = getPlayer(editId);
    if (p) { p.name = name; p.role = role; p.basePrice = base; if (photo) p.photo = photo;
      if (stats) p.stats = stats; else delete p.stats; }
  } else {
    const np = { id: uid(), name, role, basePrice: base, photo: photo || "", status: "available", soldTo: null, soldPrice: null };
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
  fillStatsForm(p.stats);
  $("#playerFormTitle").textContent = "Edit Player";
  $("#btnSavePlayer").textContent = "Save Changes";
  $("#btnCancelPlayer").classList.remove("hidden");
  switchTab("setup");
  $("#pName").focus();
}
function clearPlayerForm() {
  $("#playerEditId").value = ""; $("#pName").value = ""; $("#pRole").value = ""; $("#pBase").value = ""; $("#pPhotoFile").value = "";
  fillStatsForm(null);
  $("#playerFormTitle").textContent = "Add Player";
  $("#btnSavePlayer").textContent = "Add Player";
  $("#btnCancelPlayer").classList.add("hidden");
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
    current.basePrice = price || 0; current.soldPrice = price;
    if (photo) current.photo = photo;
  } else {
    state.players.push({
      id: uid(), name, role, basePrice: price || 0, photo: photo || "",
      status: "sold", retained: true, soldTo: teamId, soldPrice: price,
    });
  }
  clearRetainForm();
  save();
  renderAll();
  toast("Retained player saved", "good");
}
function editRetain(id) {
  const p = getPlayer(id); if (!p) return;
  $("#retainEditId").value = p.id;
  $("#retainTeam").value = p.soldTo || "";
  $("#rName").value = p.name;
  $("#rRole").value = p.role || "";
  $("#rPrice").value = p.soldPrice ?? "";
  $("#retainFormTitle").textContent = "Edit Retained Player";
  $("#btnSaveRetain").textContent = "Save Changes";
  $("#btnCancelRetain").classList.remove("hidden");
  switchTab("setup");
  $("#rName").focus();
}
function clearRetainForm() {
  $("#retainEditId").value = ""; $("#rName").value = ""; $("#rRole").value = ""; $("#rPrice").value = ""; $("#rPhotoFile").value = "";
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
  });
  state.auction = { currentPlayerId: null, currentBid: 0, currentBidderId: null, soldStage: 0, bidLog: [], lastResult: null };
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
    switchTab(tab.dataset.tab);
    if (tab.dataset.tab === "auctions") switchSubTab("auction"); // land on Auction Room by default
    if (tab.dataset.tab === "rankings") switchSubTab("ranking"); // land on Player Ranking by default
  });
  // Sub-tab bars - the Auction and Rankings sections share the same
  // .subtab pattern; switchSubTab scopes the toggle to the right section.
  document.addEventListener("click", e => {
    const st = e.target.closest(".subtab");
    if (st) switchSubTab(st.dataset.subtab);
  });

  // any [data-goto] button (empty state, overlay)
  document.addEventListener("click", e => {
    const g = e.target.closest("[data-goto]");
    if (g) { hideOverlay(); switchTab(g.dataset.goto); }
  });

  // auctioneer controls
  $("#btnSold").onclick = advanceSold;
  $("#btnUnsold").onclick = markUnsold;
  $("#btnUndo").onclick = undoLast;
  $("#btnReset").onclick = resetBid;

  // settings
  $("#btnSaveSettings").onclick = saveSettings;

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
function auOnSeriesChange(S) {
  if (!S.ready) return;
  const tid = S.viewingId();
  if (!auUsingFirestore) { auMaybeStartSync(); return; }
  if (tid === auTid) return;
  auTid = tid;
  auGen++; // disarm any pending fallback timer from the old subscriptions
  auUnsubs.splice(0).forEach(u => { try { u(); } catch (e) {} });
  auFsReady = false; auFsLoaded.clear(); auFellBack = false;
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
      renderAll(); updateCloudUploadBtn(); // re-render so gating applies live
    });
  }
  // Tournament switching (js/series.js) - resubscribe when the viewed one changes.
  if (window.HCCLSeries) window.HCCLSeries.onChange(auOnSeriesChange);
}
// Defer to DOMContentLoaded so the firebase-init.js MODULE (deferred) has already run
// and exposed window.HCCL - otherwise the onChange hook above never registers and the
// auction never syncs to Firestore. (fantasy.js does the same; that's why it works.)
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
