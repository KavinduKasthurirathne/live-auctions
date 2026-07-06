/* ============================================================
   HCCL Home page  (renders into #view-home)

   Landing view after sign-in: a branded hero (league logo + big
   "HC CHAMPIONS LEAGUE" title + tagline) and a sliding carousel of
   past seasons. The SEASONS array below is the seed source + offline
   fallback; when signed in, the same data is read from Firestore
   (home/seasons) so it stays consistent across devices - "seed once,
   read-only", mirroring ranking.js. No dependencies beyond the DOM.
   ============================================================ */
(function () {
  "use strict";

  // -------- sample season data (replace with real values later) --------
  // champion / runnerUp are TEAM names (rendered as team-logo bubbles);
  // mvp / mostRuns / mostWickets are PLAYER names (rendered as photo bubbles).
  // Each: { no, year, ongoing?, champion, runnerUp, mvp, mostRuns, mostWickets }
  const SEASONS = [
    { no: 1, year: "2025 NOV", champion: "SUPER FIRE DRAGONS", runnerUp: "MATRIX", mvp: "SASINDU MADUSHAN", mostRuns: "HASITHA LAKMAL", mostWickets: "SASINDU MADUSHAN" },
    { no: 2, year: "2025 DEC", champion: "ZYCO KINGS", runnerUp: "WIZARD TITANS", mvp: "UDARA PERERA", mostRuns: "YASITHA NAWOD", mostWickets: "UDARA PERERA" },
    { no: 3, year: "2026 JAN", champion: "MIND GAMERS", runnerUp: "INVINCIBLE LORDS", mvp: "THENU PABEESHA", mostRuns: "THENU PABEESHA", mostWickets: "UDARA PERERA" },
    { no: 4, year: "2026 FEB", champion: "VELOCITY REAPERS", runnerUp: "AURA DYNASTY", mvp: "CHATHUKA LAKSHAN", mostRuns: "CHATHUKA LAKSHAN", mostWickets: "UDARA PERERA" },
    { no: 5, year: "2026 MAY", champion: "SUPER FIRE DRAGONS", runnerUp: "WIZARD TITANS", mvp: "YATHISH LEYON", mostRuns: "SASINDU MADUSHAN", mostWickets: "UDARA PERERA" },
    { no: 6, year: "2026 JUN", ongoing: true, champion: "—", runnerUp: "—", mvp: "—", mostRuns: "SASINDU MADUSHAN", mostWickets: "YASITHA NAWOD" },
  ];

  const AUTOPLAY_MS = 6000;
  // Bump when the SEASONS data above changes so an editor re-publishes the
  // cloud copy (home/seasons); everyone signed in reads that copy.
  const SEASONS_VERSION = "2026-07-06";
  const pad2 = n => String(n).padStart(2, "0");

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  let index = 0;         // current slide
  let timer = null;      // autoplay handle
  let cloudSeasons = null; // seasons read from Firestore (home/seasons), or null
  // Cloud copy wins when present; otherwise the bundled SEASONS render offline.
  const getSeasons = () => (cloudSeasons && cloudSeasons.length) ? cloudSeasons : SEASONS;

  /* ---------- bubble helpers (team logos / player photos) ---------- */
  const BUBBLE_COLORS = ["#e10600", "#f5b301", "#22c55e", "#3b82f6", "#a855f7", "#ec4899", "#14b8a6", "#f97316"];
  function bubbleColor(s) {
    let h = 0; s = String(s || "");
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return BUBBLE_COLORS[Math.abs(h) % BUBBLE_COLORS.length];
  }
  const firstInitial = s => { const t = String(s || "").trim(); return t && t !== "—" ? t[0].toUpperCase() : "?"; };

  // Committed asset files (exact names; extensions vary between .png/.jpeg).
  // A team/player NAME from SEASONS resolves to its file via a lookup keyed by
  // the lowercased basename, so the UPPERCASE SEASONS values match regardless
  // of case. Add a file here (and to SEASONS) to introduce a new team/player.
  const TEAM_LOGO_FILES = [
    "Aura Dynasty.jpeg", "Invincible Lords.jpeg", "Matrix.jpeg", "Mind Gamers.jpeg",
    "Silentearz.jpeg", "Super Fire Dragons.jpeg", "Velocity Reapers.jpeg", "Wizard Titans.jpeg", "Zyco Kings.jpeg",
  ];
  const PLAYER_PHOTO_FILES = [
    "Chathuka Lakshan.jpeg", "Hasitha Lakmal.png", "Sasindu Madushan.png", "Thenu Pabeesha.png",
    "Udara Perera.jpeg", "Yasitha Nawod.jpeg", "Yathish Leyon.png",
  ];
  const SEASON_LOGO_FILES = {
    1: "S1 LOGO.png", 2: "S2 LOGO.png", 3: "S3 LOGO.png",
    4: "S4 LOGO.png", 5: "S5 LOGO.png", 6: "S6 LOGO.jpg",
  };
  function fileIndex(files) {
    const m = {};
    files.forEach(f => { m[f.replace(/\.[^.]+$/, "").trim().toLowerCase()] = f; });
    return m;
  }
  const TEAM_LOGO_INDEX = fileIndex(TEAM_LOGO_FILES);
  const PLAYER_PHOTO_INDEX = fileIndex(PLAYER_PHOTO_FILES);
  // Encode so the spaces in folder/file names survive inside url()/href.
  const assetUrl = p => encodeURI(p);

  function teamLogo(team) {
    const f = TEAM_LOGO_INDEX[String(team || "").trim().toLowerCase()];
    return f ? assetUrl(`assets/Team Logos/${f}`) : "";
  }
  function playerPhoto(name) {
    const f = PLAYER_PHOTO_INDEX[String(name || "").trim().toLowerCase()];
    return f ? assetUrl(`assets/Key Players/${f}`) : "";
  }
  function seasonLogo(no) {
    const f = SEASON_LOGO_FILES[no];
    return f ? assetUrl(`assets/HCCL Logos/${f}`) : "";
  }
  // A round bubble: team logo / player photo if known, else a colored initial.
  function bubble(kind, value) {
    const img = kind === "team" ? teamLogo(value) : playerPhoto(value);
    return img
      ? `<span class="bubble" style="background-image:url('${img}')"></span>`
      : `<span class="bubble fallback" style="background:${bubbleColor(value)}">${esc(firstInitial(value))}</span>`;
  }

  function podiumItem(cls, role, kind, value) {
    return `<div class="podium-item ${cls}">
      ${bubble(kind, value)}
      <span class="podium-role">${role}</span>
      <span class="podium-name">${esc(value)}</span>
    </div>`;
  }
  function extraItem(icon, label, name) {
    return `<div class="extra-item">
      ${bubble("player", name)}
      <div class="extra-meta">
        <span class="extra-label">${icon} ${label}</span>
        <span class="extra-name">${esc(name)}</span>
      </div>
    </div>`;
  }

  function seasonBadge(s) {
    const l = seasonLogo(s.no);
    return l
      ? `<div class="season-no has-logo" style="background-image:url('${l}')"></div>`
      : `<div class="season-no">S${pad2(s.no)}</div>`;
  }

  function seasonCardHtml(s) {
    return `
      <article class="season-card">
        <div class="season-card-head">
          ${seasonBadge(s)}
          <div class="season-meta">
            <h3>Season ${pad2(s.no)}</h3>
            <span class="season-year">${esc(s.year)}${s.ongoing ? ` · <span class="season-live">ONGOING</span>` : ""}</span>
          </div>
        </div>
        <div class="podium">
          ${podiumItem("mvp", "MVP", "player", s.mvp)}
          ${podiumItem("champion", "Champion", "team", s.champion)}
          ${podiumItem("runner", "Runner-up", "team", s.runnerUp)}
        </div>
        <div class="season-extra">
          ${extraItem("🏏", "Most Runs", s.mostRuns)}
          ${extraItem("🎯", "Most Wickets", s.mostWickets)}
        </div>
      </article>`;
  }

  function render() {
    const view = document.getElementById("view-home");
    if (!view) return;
    const list = getSeasons();
    view.innerHTML = `
      <section class="home-hero">
        <div class="home-hero-logo" style="background-image:url('assets/brand-logo.jpg')"></div>
        <h1 class="home-hero-title">HC CHAMPIONS LEAGUE</h1>
        <p class="home-hero-sub">THE HOME OF HAND CRICKET CHAMPIONS</p>
        <p class="home-hero-tags">Live Auctions · Fantasy League · Player Rankings</p>
      </section>

      <section class="home-seasons">
        <div class="home-seasons-head">
          <h2>Seasons</h2>
          <div class="carousel-nav">
            <button class="carousel-btn" id="seasonPrev" aria-label="Previous season">‹</button>
            <button class="carousel-btn" id="seasonNext" aria-label="Next season">›</button>
          </div>
        </div>
        <div class="season-carousel" id="seasonCarousel">
          <div class="season-track" id="seasonTrack">
            ${list.map(seasonCardHtml).join("")}
          </div>
        </div>
        <div class="carousel-dots" id="seasonDots">
          ${list.map((s, i) => `<button class="dot${i === index ? " on" : ""}" data-go="${i}" aria-label="Season ${pad2(s.no)}"></button>`).join("")}
        </div>
      </section>`;
    applyIndex();
    // Pause autoplay while the pointer is over the carousel.
    const car = document.getElementById("seasonCarousel");
    if (car) {
      car.addEventListener("mouseenter", stopAutoplay);
      car.addEventListener("mouseleave", restartAutoplay);
    }
  }

  // Slide the track and light the active dot (no full re-render).
  function applyIndex() {
    const track = document.getElementById("seasonTrack");
    if (track) track.style.transform = `translateX(-${index * 100}%)`;
    document.querySelectorAll("#seasonDots .dot").forEach((d, i) =>
      d.classList.toggle("on", i === index));
  }

  function go(i, user) {
    const n = getSeasons().length;
    index = (i + n) % n;
    applyIndex();
    if (user) restartAutoplay(); // reset the timer after a manual move
  }

  function restartAutoplay() {
    stopAutoplay();
    timer = setInterval(() => go(index + 1, false), AUTOPLAY_MS);
  }
  function stopAutoplay() { if (timer) { clearInterval(timer); timer = null; } }

  function onClick(e) {
    if (e.target.closest("#seasonNext")) return go(index + 1, true);
    if (e.target.closest("#seasonPrev")) return go(index - 1, true);
    const dot = e.target.closest("[data-go]");
    if (dot) go(parseInt(dot.getAttribute("data-go"), 10) || 0, true);
  }

  /* ---------------- Firestore: read cloud seasons + editor seed --------------- */
  // "Seed once, read-only" (mirrors ranking.js): everyone reads home/seasons; an
  // editor whose bundled data is newer than the stored doc (re)publishes it.
  // Viewers never write (Firestore rules enforce it) and fall back to SEASONS.
  let homeSyncStarted = false;
  function startHomeSync() {
    const H = window.HCCL;
    if (homeSyncStarted || !H || !H.configured || !H.user || !H.db || !H.fs) return;
    const fs = H.fs;
    if (!fs.doc || !fs.onSnapshot) return;
    homeSyncStarted = true;
    const ref = fs.doc(H.db, "home", "seasons");
    fs.onSnapshot(ref, snap => {
      const data = snap.exists() ? snap.data() : null;
      const fresh = !!(data && data.version === SEASONS_VERSION && Array.isArray(data.seasons));
      if (fresh) {
        cloudSeasons = data.seasons;
        if (index >= cloudSeasons.length) index = 0; // keep the slide in range
        render();
      }
      // Missing or stale -> an editor publishes the current bundled seasons.
      if (!fresh && H.canEdit && H.canEdit() && fs.setDoc) {
        fs.setDoc(ref, {
          version: SEASONS_VERSION,
          updatedAt: fs.serverTimestamp ? fs.serverTimestamp() : Date.now(),
          seasons: SEASONS,
        }).catch(err => console.error("home cloud seed failed:", err));
      }
    }, err => console.error("home snapshot error:", err));
  }

  function init() {
    const view = document.getElementById("view-home");
    if (!view) return;
    view.addEventListener("click", onClick);
    // Read cloud seasons (and seed them, if an editor) once signed in.
    if (window.HCCL && typeof window.HCCL.onChange === "function") {
      window.HCCL.onChange(() => startHomeSync());
    }
    render();
    restartAutoplay();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
