/* ============================================================
   HC Leagues Home page  (renders into #view-home)

   Landing view after sign-in:
     1. Branded hero (site logo + "HC LEAGUES" + tagline).
     2. Champions carousel - auto-advancing cards, one per finished
        HCCL season (honors from window.HCCLSeasonArchive) plus one
        per finished registry tournament that has honors recorded
        (window.HCCLSeries). Left side: logo + title; right side:
        Champion / Runner-up / MVP podium. Live seasons/tournaments
        lead with a LIVE card (current Most Runs / Most Wickets).
     3. News shell (#homeNews) - filled by js/news.js.

   The per-season honors & leaderboards that used to live here moved
   to js/season-archive.js and are shown inside the Series tab's
   HCCL tournament hub. This module only READS the archive (and the
   series registry) to build carousel cards, and re-renders when
   either reports a data change.
   ============================================================ */
(function () {
  "use strict";

  const AUTO_ADVANCE_MS = 6500;
  const pad2 = n => String(n).padStart(2, "0");

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  const archive = () => window.HCCLSeasonArchive || null;
  const series = () => window.HCCLSeries || null;

  /* ---------------------- carousel cards ---------------------- */
  // A tournament/season logo block: image when we have one, else initials.
  function cardLogo(img, name) {
    if (img) return `<div class="champs-logo" style="background-image:url('${img}')"></div>`;
    const initials = esc(String(name || "?").trim().split(/\s+/).map(w => w[0]).join("").slice(0, 3).toUpperCase());
    return `<div class="champs-logo fallback">${initials}</div>`;
  }

  function cardHtml(c) {
    return `<article class="champs-card${c.live ? " live" : ""}">
      <div class="champs-left">
        ${cardLogo(c.logo, c.title)}
        <div class="champs-meta">
          ${c.league ? `<span class="champs-league">${esc(c.league)}</span>` : ""}
          <h3 class="champs-name">${esc(c.title)}</h3>
          ${c.duration ? `<span class="champs-dur">${esc(c.duration)}</span>` : ""}
          ${c.live ? `<span class="champs-live">● LIVE</span>` : ""}
        </div>
      </div>
      <div class="champs-right">
        ${c.rightHtml}
      </div>
    </article>`;
  }

  // Card list, newest first: LIVE cards lead, then completed tournaments from
  // the registry (they're newer than the archived HCCL seasons), then the
  // finished HCCL seasons.
  function buildCards() {
    const A = archive();
    const S = series();
    const cards = [];

    // Ongoing HCCL season: champions aren't decided, so a podium would be a row
    // of TBDs - the current Most Runs / Most Wickets race reads far better.
    const live = A && A.ongoing();
    if (live) {
      const lead = A.leaders(live.no);
      cards.push({
        live: true,
        logo: A.seasonLogo(live.no),
        league: "HC Champions League",
        title: `Season ${pad2(live.no)}`,
        duration: live.year || "",
        rightHtml: `<div class="champs-race">
          ${A.extraItem("🏏", "Most Runs", lead.mostRuns || "TBD")}
          ${A.extraItem("🎯", "Most Wickets", lead.mostWickets || "TBD")}
        </div>`,
      });
    }

    const list = S ? S.list() : [];
    // Live registry tournaments (the legacy entry is the ongoing HCCL season -
    // already covered by the archive card above).
    list.filter(t => !t.legacy && t.status === "live").forEach(t => {
      cards.push({
        live: true,
        logo: t.logo, title: t.name, duration: t.duration,
        rightHtml: `<div class="champs-progress">Tournament in progress<span>Follow it in the 🏆 Series tab</span></div>`,
      });
    });

    // Completed registry tournaments with recorded honors, newest first.
    list.filter(t => !t.legacy && t.status === "completed" && t.honors && t.honors.champion)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .forEach(t => {
        cards.push({
          logo: t.logo, title: t.name, duration: t.duration,
          rightHtml: A ? A.podiumHtml(t.honors) : "",
        });
      });

    // Finished HCCL seasons, newest first.
    if (A) {
      A.seasons().filter(s => !s.ongoing && s.champion).sort((a, b) => b.no - a.no).forEach(s => {
        cards.push({
          logo: A.seasonLogo(s.no),
          league: "HC Champions League",
          title: `Season ${pad2(s.no)}`,
          duration: s.year || "",
          rightHtml: A.podiumHtml(s),
        });
      });
    }
    return cards;
  }

  /* ---------------------- carousel behaviour ---------------------- */
  // One live carousel at a time; render() destroys and rebuilds it, so a timer
  // can never keep driving a track that innerHTML replacement just orphaned.
  let champsTimer = null;
  let champsScrollRaf = 0;
  const onVisibility = () => { if (document.hidden) stopAutoAdvance(); else startAutoAdvance(); };

  const reducedMotion = () =>
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function champsEls() {
    const view = document.getElementById("view-home");
    const root = view && view.querySelector(".champs");
    if (!root) return null;
    return {
      root,
      track: root.querySelector(".champs-track"),
      cards: Array.from(root.querySelectorAll(".champs-card")),
      dots: Array.from(root.querySelectorAll(".champs-dot")),
    };
  }

  function currentIndex(els) {
    if (!els.cards.length) return 0;
    const x = els.track.scrollLeft;
    let best = 0, dist = Infinity;
    els.cards.forEach((c, i) => {
      const d = Math.abs(c.offsetLeft - x);
      if (d < dist) { dist = d; best = i; }
    });
    return best;
  }

  function goTo(i, smooth) {
    const els = champsEls();
    if (!els || !els.cards.length) return;
    const n = els.cards.length;
    const idx = ((i % n) + n) % n;
    // Exact card offsets so programmatic scrolls land on the snap points.
    els.track.scrollTo({ left: els.cards[idx].offsetLeft, behavior: smooth && !reducedMotion() ? "smooth" : "auto" });
  }

  function updateDots() {
    const els = champsEls();
    if (!els) return;
    const idx = currentIndex(els);
    els.dots.forEach((d, i) => d.classList.toggle("active", i === idx));
  }

  function startAutoAdvance() {
    stopAutoAdvance();
    if (reducedMotion()) return;
    const els = champsEls();
    if (!els || els.cards.length < 2) return;
    champsTimer = setInterval(() => {
      const e = champsEls();
      if (!e) { stopAutoAdvance(); return; }
      goTo(currentIndex(e) + 1, true);
    }, AUTO_ADVANCE_MS);
  }

  function stopAutoAdvance() {
    if (champsTimer) { clearInterval(champsTimer); champsTimer = null; }
  }

  function destroyCarousel() {
    stopAutoAdvance();
    document.removeEventListener("visibilitychange", onVisibility);
  }

  function initCarousel() {
    const els = champsEls();
    if (!els) return;
    // Track scroll (wheel, touch, snap settle) -> keep the dots honest.
    els.track.addEventListener("scroll", () => {
      cancelAnimationFrame(champsScrollRaf);
      champsScrollRaf = requestAnimationFrame(updateDots);
    }, { passive: true });
    // Hovering / touching / focusing the carousel pauses the slideshow so it
    // never yanks a card away mid-read; leaving resumes it.
    els.root.addEventListener("pointerenter", stopAutoAdvance);
    els.root.addEventListener("pointerdown", stopAutoAdvance);
    els.root.addEventListener("focusin", stopAutoAdvance);
    els.root.addEventListener("pointerleave", startAutoAdvance);
    els.root.addEventListener("focusout", startAutoAdvance);
    document.addEventListener("visibilitychange", onVisibility);
    startAutoAdvance();
  }

  function onHomeClick(e) {
    const prev = e.target.closest("[data-champs-prev]");
    const next = e.target.closest("[data-champs-next]");
    const dot = e.target.closest("[data-champs-dot]");
    if (!prev && !next && !dot) return;
    const els = champsEls();
    if (!els) return;
    if (dot) goTo(parseInt(dot.getAttribute("data-champs-dot"), 10) || 0, true);
    else goTo(currentIndex(els) + (next ? 1 : -1), true);
    startAutoAdvance(); // manual nav restarts the clock so the next hop isn't instant
  }

  /* ------------------------- rendering ------------------------- */
  function champsHtml() {
    const cards = buildCards();
    if (!cards.length) return "";
    return `<section class="champs" aria-label="Champions">
      <div class="champs-head">
        <h2 class="champs-title">🏆 Hall of Champions</h2>
        <div class="champs-nav">
          <button class="champs-arrow" data-champs-prev aria-label="Previous">‹</button>
          <button class="champs-arrow" data-champs-next aria-label="Next">›</button>
        </div>
      </div>
      <div class="champs-track">
        ${cards.map(cardHtml).join("")}
      </div>
      <div class="champs-dots">
        ${cards.map((c, i) => `<button class="champs-dot${i === 0 ? " active" : ""}" data-champs-dot="${i}" aria-label="Card ${i + 1}"></button>`).join("")}
      </div>
    </section>`;
  }

  function render() {
    const view = document.getElementById("view-home");
    if (!view) return;
    destroyCarousel(); // before innerHTML replacement orphans the old track
    view.innerHTML = `
      <section class="home-hero">
        <div class="home-hero-logo" style="background-image:url('assets/brand-logo.jpg')"></div>
        <h1 class="home-hero-title">HC LEAGUES</h1>
        <p class="home-hero-sub">A PLACE WHERE HAND CRICKET CHAMPIONS SHINE</p>
        <p class="home-hero-tags">Live Auctions · Fantasy League · Player Rankings</p>
      </section>
      ${champsHtml()}
      <section class="home-news" id="homeNews"></section>`;
    initCarousel();
    // news.js owns the feed; refill the shell we just rebuilt.
    if (window.HCCLNews && typeof window.HCCLNews.render === "function") window.HCCLNews.render();
  }

  // The registry, the archive and auth all emit around the same moments
  // (sign-in, first snapshots) - coalesce to one render per frame.
  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  function init() {
    const view = document.getElementById("view-home");
    if (!view) return;
    view.addEventListener("click", onHomeClick);
    if (archive()) archive().onChange(scheduleRender);
    if (series()) series().onChange(scheduleRender);
    if (window.HCCL && typeof window.HCCL.onChange === "function") window.HCCL.onChange(scheduleRender);
    render();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
