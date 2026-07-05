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
  // Each: { no, year, ongoing?, winner, runnerUp, third, mostRuns, mostWickets, mvp }
  const SEASONS = [
    { no: 1, year: "2021", winner: "TBD", runnerUp: "TBD", third: "TBD", mostRuns: "TBD", mostWickets: "TBD", mvp: "TBD" },
    { no: 2, year: "2022", winner: "TBD", runnerUp: "TBD", third: "TBD", mostRuns: "TBD", mostWickets: "TBD", mvp: "TBD" },
    { no: 3, year: "2023", winner: "TBD", runnerUp: "TBD", third: "TBD", mostRuns: "TBD", mostWickets: "TBD", mvp: "TBD" },
    { no: 4, year: "2024", winner: "TBD", runnerUp: "TBD", third: "TBD", mostRuns: "TBD", mostWickets: "TBD", mvp: "TBD" },
    { no: 5, year: "2025", winner: "TBD", runnerUp: "TBD", third: "TBD", mostRuns: "TBD", mostWickets: "TBD", mvp: "TBD" },
    { no: 6, year: "2026", ongoing: true, winner: "—", runnerUp: "—", third: "—", mostRuns: "TBD", mostWickets: "TBD", mvp: "TBD" },
  ];

  const AUTOPLAY_MS = 6000;
  const pad2 = n => String(n).padStart(2, "0");

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  let index = 0;         // current slide
  let timer = null;      // autoplay handle

  function statRow(icon, label, value, cls) {
    return `<div class="ss-row${cls ? " " + cls : ""}">
      <span class="ss-ico">${icon}</span>
      <span class="ss-label">${label}</span>
      <span class="ss-value">${esc(value)}</span>
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
        <div class="season-stats">
          ${statRow("🏆", "Champion", s.winner, "gold")}
          ${statRow("🥈", "Runner-up", s.runnerUp)}
          ${statRow("🥉", "Third place", s.third)}
          ${statRow("🏏", "Most Runs", s.mostRuns)}
          ${statRow("🎯", "Most Wickets", s.mostWickets)}
          ${statRow("⭐", "MVP", s.mvp)}
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
