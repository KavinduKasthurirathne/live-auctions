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
      bidIncrement: 1,
    },
    teams: [],   // { id, name, logo, purse }
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
  try { localStorage.setItem(KEY, JSON.stringify(state)); }
  catch (e) { toast("Storage fullexport a backup and use smaller images", "bad"); }
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

/* ============================================================
   TABS
   ============================================================ */
function switchTab(name) {
  $$(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
  $$(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + name));
}

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
}

function renderHeader() {
  const { seasonName, seasonNumber, leagueLogo } = state.settings;
  const num = String(seasonNumber).padStart(2, "0");
  $("#seasonTitle").textContent = `${seasonName} Season ${num}`;
  document.title = `${seasonName} S${num} · Auction`;
  setPhoto($("#brandLogo"), leagueLogo, initials(seasonName));
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
    const remaining = teamRemaining(t);
    const leading = a.currentBidderId === t.id;
    const cantAfford = remaining < next;
    const btn = document.createElement("button");
    btn.className = "team-bid-btn" + (leading ? " leading" : "");
    btn.disabled = leading || cantAfford;
    btn.title = leading ? "Currently leading"
      : cantAfford ? `Not enough purse for ${money(next)}`
      : `Bid ${money(next)} for ${t.name}`;
    btn.innerHTML = `
      ${logoHTML("tb-logo", t.logo, t.name)}
      <span class="tb-meta">
        <span class="tb-name">${esc(t.name)}</span>
        <span class="tb-purse">${leading ? "★ Leading" : money(remaining) + " left"}</span>
      </span>
      ${i < 9 ? `<span class="tb-key">${i + 1}</span>` : ""}`;
    btn.onclick = () => placeBid(t.id);
    grid.appendChild(btn);
  });
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

/* Pure bid rule. Returns the new auction object, or null if the bid isn't allowed. */
function computeBidResult(s, teamId) {
  const a = s.auction;
  if (!a || a.currentBidderId === teamId) return null; // can't out-bid yourself
  const player = s.players.find(p => p.id === a.currentPlayerId);
  if (!player) return null;
  const inc = Number(s.settings.bidIncrement) || 1;
  const amount = a.currentBidderId == null ? player.basePrice : a.currentBid + inc;
  const team = s.teams.find(t => t.id === teamId);
  if (!team) return null;
  const purse = (team.purse != null ? team.purse : s.settings.defaultPurse);
  const spent = s.players.filter(p => p.status === "sold" && !p.retained && p.soldTo === teamId).reduce((x, p) => x + (p.soldPrice || 0), 0);
  if (purse - spent < amount) return null; // can't afford
  return {
    currentPlayerId: a.currentPlayerId,
    currentBid: amount, currentBidderId: teamId, soldStage: 0,
    bidLog: [...(a.bidLog || []), { teamId, amount }],
    lastResult: null,
  };
}

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
  switchTab("auction");
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
      <span class="ml-sub">${money(teamPurse(t))}</span>
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
  const f = $("#teamLogoFile").files[0];
  let logo = null;
  if (f) { try { logo = await fileToDataURL(f, 220, "png"); } catch (e) { toast("Couldn't read logo", "bad"); } }

  const editId = $("#teamEditId").value;
  if (editId) {
    const t = getTeam(editId);
    if (t) { t.name = name; t.purse = purse; if (logo) t.logo = logo; }
  } else {
    state.teams.push({ id: uid(), name, purse, logo: logo || "" });
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
  $("#teamFormTitle").textContent = "Edit Team";
  $("#btnSaveTeam").textContent = "Save Changes";
  $("#btnCancelTeam").classList.remove("hidden");
  switchTab("setup");
  $("#teamName").focus();
}
function clearTeamForm() {
  $("#teamEditId").value = ""; $("#teamName").value = ""; $("#teamPurse").value = ""; $("#teamLogoFile").value = "";
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
  if (editId) {
    const p = getPlayer(editId);
    if (p) { p.name = name; p.role = role; p.basePrice = base; if (photo) p.photo = photo; }
  } else {
    state.players.push({ id: uid(), name, role, basePrice: base, photo: photo || "", status: "available", soldTo: null, soldPrice: null });
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
  $("#playerFormTitle").textContent = "Edit Player";
  $("#btnSavePlayer").textContent = "Save Changes";
  $("#btnCancelPlayer").classList.remove("hidden");
  switchTab("setup");
  $("#pName").focus();
}
function clearPlayerForm() {
  $("#playerEditId").value = ""; $("#pName").value = ""; $("#pRole").value = ""; $("#pBase").value = ""; $("#pPhotoFile").value = "";
  $("#playerFormTitle").textContent = "Add Player";
  $("#btnSavePlayer").textContent = "Add Player";
  $("#btnCancelPlayer").classList.add("hidden");
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
  switchTab("auction");
  toast("Sample data loaded", "good");
}
function reauctionUnsold() {
  const u = state.players.filter(p => p.status === "unsold");
  if (!u.length) { toast("No unsold players", "bad"); return; }
  u.forEach(p => { p.status = "available"; });
  save();
  renderAll();
  switchTab("auction");
  toast(`${u.length} player(s) re-opened`, "good");
}
function resetAuction() {
  if (!confirm("Reset all auction results?\n\nTeams and players stay (retained players are kept), but every auctioned player becomes Available and purses are restored.")) return;
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
  if (!confirm("Erase EVERYTHINGteams, players and settings?")) return;
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
    if (tab) switchTab(tab.dataset.tab);
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
    if (!$("#view-auction").classList.contains("active")) return;
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
function init() {
  wireEvents();
  fillSettingsInputs();
  ensureCurrentPlayer();
  save();
  renderAll();
}
init();
