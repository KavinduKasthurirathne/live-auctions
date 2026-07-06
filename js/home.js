/* ============================================================
   HCCL Home page  (renders into #view-home)

   Landing view after sign-in: a branded hero (league logo + big
   "HC CHAMPIONS LEAGUE" title + tagline) and a sliding carousel of
   past seasons. This is a SAMPLE - the SEASONS data below is
   placeholder; swap in the real winners/stats later. Self-contained
   (mirrors ranking.js): no dependencies beyond the DOM.
   ============================================================ */
(function () {
  "use strict";

  // -------- sample season data (replace with real values later) --------
  // champion / runnerUp are TEAM names (rendered as team-logo bubbles);
  // mvp / mostRuns / mostWickets are PLAYER names (rendered as photo bubbles).
  // Each: { no, year, ongoing?, champion, runnerUp, mvp, mostRuns, mostWickets }
  const SEASONS = [
    { no: 1, year: "2021", champion: "TBD", runnerUp: "TBD", mvp: "TBD", mostRuns: "TBD", mostWickets: "TBD" },
    { no: 2, year: "2022", champion: "TBD", runnerUp: "TBD", mvp: "TBD", mostRuns: "TBD", mostWickets: "TBD" },
    { no: 3, year: "2023", champion: "TBD", runnerUp: "TBD", mvp: "TBD", mostRuns: "TBD", mostWickets: "TBD" },
    { no: 4, year: "2024", champion: "TBD", runnerUp: "TBD", mvp: "TBD", mostRuns: "TBD", mostWickets: "TBD" },
    { no: 5, year: "2025", champion: "TBD", runnerUp: "TBD", mvp: "TBD", mostRuns: "TBD", mostWickets: "TBD" },
    { no: 6, year: "2026", ongoing: true, champion: "—", runnerUp: "—", mvp: "—", mostRuns: "TBD", mostWickets: "TBD" },
  ];

  const AUTOPLAY_MS = 6000;
  const pad2 = n => String(n).padStart(2, "0");

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  let index = 0;         // current slide
  let timer = null;      // autoplay handle

  /* ---------- bubble helpers (team logos / player photos) ---------- */
  const BUBBLE_COLORS = ["#e10600", "#f5b301", "#22c55e", "#3b82f6", "#a855f7", "#ec4899", "#14b8a6", "#f97316"];
  function bubbleColor(s) {
    let h = 0; s = String(s || "");
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return BUBBLE_COLORS[Math.abs(h) % BUBBLE_COLORS.length];
  }
  const firstInitial = s => { const t = String(s || "").trim(); return t && t !== "—" ? t[0].toUpperCase() : "?"; };

  // Look up a team logo / player photo from the auction data (app.js `state`,
  // same global scope). Matching is by keyword contained in the full name,
  // so "Lords" resolves "INVINCIBLE LORDS". Empty until data is filled in.
  function teamLogo(team) {
    try {
      if (typeof state === "undefined" || !state || !Array.isArray(state.teams)) return "";
      const kw = String(team || "").toLowerCase();
      const t = state.teams.find(x => (x.name || "").toLowerCase().includes(kw));
      return (t && t.logo) || "";
    } catch (e) { return ""; }
  }
  function playerPhoto(name) {
    try {
      if (typeof state === "undefined" || !state || !Array.isArray(state.players)) return "";
      const kw = String(name || "").toLowerCase();
      const p = state.players.find(x => (x.name || "").toLowerCase().includes(kw));
      return (p && p.photo) || "";
    } catch (e) { return ""; }
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

  function seasonCardHtml(s) {
    return `
      <article class="season-card">
        <div class="season-card-head">
          <div class="season-no">S${pad2(s.no)}</div>
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
    view.innerHTML = `
      <section class="home-hero">
        <div class="home-hero-logo" style="background-image:url('brand-logo.jpg')"></div>
        <h1 class="home-hero-title">HC CHAMPIONS LEAGUE</h1>
        <p class="home-hero-sub">The home of hand cricket champions</p>
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
            ${SEASONS.map(seasonCardHtml).join("")}
          </div>
        </div>
        <div class="carousel-dots" id="seasonDots">
          ${SEASONS.map((s, i) => `<button class="dot${i === index ? " on" : ""}" data-go="${i}" aria-label="Season ${pad2(s.no)}"></button>`).join("")}
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
    index = (i + SEASONS.length) % SEASONS.length;
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

  function init() {
    const view = document.getElementById("view-home");
    if (!view) return;
    view.addEventListener("click", onClick);
    render();
    restartAutoplay();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
