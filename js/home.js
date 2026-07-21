/* ============================================================
   HC Community Home page  (renders into #view-home)

   Landing view after sign-in:
     1. Branded hero (site logo + "HC COMMUNITY" + tagline).
     2. Champions carousel - auto-advancing cards, ONE PER SERIES in
        the 🏆 Series tab (window.HCCLSeries), nothing filtered out:
        each card is logo | name + duration | Champion/Runner-up/MVP
        podium | Most Runs + Most Wickets, in tournament-date order.
        The LIVE one leads with an "in progress" card; one that hasn't
        been played yet says so instead of showing an empty podium.
     3. News shell (#homeNews) - filled by js/news.js.

   The per-season honors & leaderboards that used to live here moved
   to js/season-archive.js and are shown inside the Series tab's
   HCCL tournament hub. This module only READS the registry (for what
   exists, its status and its honors) and the archive (for season
   logos, stats-sheet leaders and the podium markup), and re-renders
   when either reports a data change.
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

  /* ---- dates parsed out of the duration string an admin typed ---- */
  const MONTH_IDX = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  function monthHits(duration) {
    const re = /(?:(\d{1,2})\s+)?(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\.?\s+(\d{4})/g;
    const s = String(duration || "").toUpperCase();
    const out = [];
    let m;
    while ((m = re.exec(s))) out.push(m);
    return out;
  }
  // Chronology key: the FIRST date of a duration ("MAR 2026 - APR 2026" -> 1 Mar
  // 2026). Unparseable strings ("COMING SOON") sink to the end, so a tournament
  // without dates never jumps the queue.
  function startStamp(duration) {
    const h = monthHits(duration)[0];
    if (!h) return Infinity;
    return new Date(+h[3], MONTH_IDX[h[2]], h[1] ? +h[1] : 1).getTime();
  }
  // Recency key: the LAST date ("MAR 2026 - APR 2026" -> 30 Apr; "JAN 2026" ->
  // 31 Jan; day 0 of the next month IS the last day of this one). Used to pick
  // the lead card when nothing is live. Undated -> -Infinity, so a "COMING
  // SOON" tournament can never be mistaken for the most recent one.
  function endStamp(duration) {
    const hits = monthHits(duration);
    const h = hits[hits.length - 1];
    if (!h) return -Infinity;
    const y = +h[3], mo = MONTH_IDX[h[2]];
    return h[1]
      ? new Date(y, mo, +h[1], 23, 59, 59).getTime()
      : new Date(y, mo + 1, 0, 23, 59, 59).getTime();
  }

  // Four zones in one row: logo | name + duration | Champion/Runner-up/MVP
  // podium | Most Runs & Most Wickets. Cards without a leaders zone drop it.
  function cardHtml(c) {
    return `<article class="champs-card${c.live ? " live" : ""}${c.rightHtml ? " has-right" : ""}">
      ${cardLogo(c.logo, c.title)}
      <div class="champs-meta">
        ${c.league ? `<span class="champs-league">${esc(c.league)}</span>` : ""}
        <h3 class="champs-name">${esc(c.title)}</h3>
        ${c.duration ? `<span class="champs-dur">${esc(c.duration)}</span>` : ""}
        ${c.live ? `<span class="champs-live">● LIVE</span>` : ""}
      </div>
      <div class="champs-mid">${c.midHtml || ""}</div>
      ${c.rightHtml ? `<div class="champs-right">${c.rightHtml}</div>` : ""}
    </article>`;
  }

  // EVERY series in the 🏆 Series tab feeds the Hall of Champions - HCCL
  // seasons and the other HC tournaments alike - so a tournament an admin adds
  // there shows up here the moment its champion is recorded. One card per
  // entry: LIVE ones carry an "in progress" note, finished ones the podium.
  // A tournament can end up in the registry TWICE - a hand-created entry plus
  // the bundled seed for the same event ("Mini IPL 2026" / "HC Mini IPL 2026").
  // The Hall of Champions shows one card per tournament, so fold each such pair
  // into a single entry: field by field, the first twin that actually HAS a
  // value wins, and a twin carrying a champion leads (the honors or the stats
  // import may have landed on either doc). The Series tab still lists both, with
  // a DUPLICATE chip, so an editor can delete the spare.
  function mergeTwins(list, S) {
    if (!S || !S.identityKey) return list;
    const groups = new Map();
    list.forEach(t => {
      const k = S.identityKey(t) || t.id;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    });
    const pick = (...vals) => vals.find(v => v !== "" && v != null && v !== false) ?? "";
    return [...groups.values()].map(g => {
      if (g.length === 1) return g[0];
      // Lead with the entry that already names a champion, else a finished/live
      // one, else the first - then let the others fill in its gaps.
      const rank = t => ((t.honors && t.honors.champion) ? 0 : 2) + (t.status === "upcoming" ? 1 : 0);
      const sorted = g.slice().sort((a, b) => rank(a) - rank(b));
      const [head, ...restT] = sorted;
      const merged = { ...head };
      const hon = { ...(head.honors || {}) };
      restT.forEach(t => {
        ["name", "short", "logo", "duration", "archive", "season", "solo", "statsOnly", "legacy"]
          .forEach(f => { if (!merged[f] && t[f]) merged[f] = t[f]; });
        Object.entries(t.honors || {}).forEach(([f, v]) => { if (!hon[f] && v) hon[f] = v; });
      });
      merged.honors = Object.keys(hon).length ? hon : null;
      merged.status = pick(...sorted.map(t => (t.status === "upcoming" ? "" : t.status)), "upcoming");
      return merged;
    });
  }

  function buildCards() {
    const A = archive();
    const S = series();
    if (!A) return [];

    const isHccl = t => !!(t.legacy || t.archive === "hccl");
    const seasonNoOf = t => t.season || (t.legacy ? 6 : 0);

    // The registry is the source of truth. If it never loaded (script error),
    // fall back to the bundled archive so Home still tells the story.
    const raw = S ? S.list() : A.seasons().map(s => ({
      id: `hccl-s${s.no}`, name: `HCCL Season ${pad2(s.no)}`,
      archive: "hccl", season: s.no, duration: s.year || "",
      status: s.ongoing ? "live" : "completed",
      honors: { champion: s.champion, runnerUp: s.runnerUp, mvp: s.mvp },
    }));
    const list = mergeTwins(raw, S);

    const leadersHtml = (mostRuns, mostWickets) => (mostRuns || mostWickets) ? `<div class="champs-race">
      ${A.extraItem("🏏", "Most Runs", mostRuns || "TBD")}
      ${A.extraItem("🎯", "Most Wickets", mostWickets || "TBD")}
    </div>` : "";

    // Most Runs / Most Wickets: an HCCL season derives them from its own stats
    // sheet; any other tournament from its imported/bundled sheet, falling back
    // to the honors fields an editor typed.
    const leadersOf = t => {
      const no = seasonNoOf(t);
      if (isHccl(t) && no) return A.leaders(no);
      const h = t.honors || {};
      const lead = { mostRuns: h.mostRuns || "", mostWickets: h.mostWickets || "" };
      const csv = A.tournamentCsv ? A.tournamentCsv(t.id, t.name) : null;
      if (csv) {
        const der = A.leadersFromRows(A.rowsFromCsv(csv));
        lead.mostRuns = der.mostRuns || lead.mostRuns;
        lead.mostWickets = der.mostWickets || lead.mostWickets;
      }
      return lead;
    };

    const cards = [];
    list.forEach(t => {
      const no = isHccl(t) ? seasonNoOf(t) : 0;
      const s = no ? (A.seasons().find(x => x.no === no) || null) : null;
      // Honors as recorded in the Series entry; for an HCCL season the bundled
      // archive fills anything the registry doesn't carry.
      const rh = t.honors || {};
      const honors = {
        champion: rh.champion || (s && s.champion) || "",
        runnerUp: rh.runnerUp || (s && s.runnerUp) || "",
        mvp: rh.mvp || (s && s.mvp) || "",
      };
      const live = t.status === "live";
      const what = no ? "Season" : "Tournament";
      // The mid zone: the podium once a champion is recorded, otherwise a note
      // saying where this one is in its life - nothing is left out of the Hall.
      const note = (head, sub) => `<div class="champs-progress">${esc(head)}<span>${esc(sub)}</span></div>`;
      const midHtml = honors.champion
        ? A.podiumHtml(honors, t.solo ? "player" : "team")
        : live
          ? note(`${what} in progress`, no ? "Champion crowned soon - follow it in 🏆 Series"
            : "Follow it in the 🏆 Series tab")
          : t.status === "upcoming"
            ? note("Coming soon", `This ${what.toLowerCase()} hasn't been played yet`)
            : note("Champion to be confirmed", "The honors for this one aren't recorded yet");
      const lead = leadersOf(t);
      cards.push({
        live,
        start: startStamp(t.duration),
        end: endStamp(t.duration),
        logo: t.logo || (no ? A.seasonLogo(no) : (A.tournamentLogo && A.tournamentLogo(t.name))) || "",
        league: no ? "HC Champions League" : "",
        title: no ? `Season ${pad2(no)}` : t.name,
        duration: t.duration || "",
        midHtml,
        rightHtml: leadersHtml(lead.mostRuns, lead.mostWickets),
      });
    });

    // No filtering: every series in the 🏆 Series tab gets a card here.
    // Order: the LIVE one leads (it's the default view). With none live, the
    // most recently finished takes the lead card instead. The rest then run
    // oldest -> newest, so the carousel walks the story forward and wraps back
    // round to the current one. A tournament with no dates at all ("COMING
    // SOON") has no place in the chronology, so it sits at the end.
    const live = cards.filter(c => c.live).sort((a, b) => a.start - b.start);
    const rest = cards.filter(c => !c.live).sort((a, b) => a.start - b.start);
    const lead = [];
    if (!live.length && rest.length) {
      const newest = rest.reduce((best, c) => (c.end > best.end ? c : best), rest[0]);
      lead.push(...rest.splice(rest.indexOf(newest), 1));
    }

    // Belt & braces behind mergeTwins(): two entries that still land on the
    // same league+title (identical names) collapse to a single card.
    const seen = new Set();
    const uniq = c => {
      const k = `${c.league || ""}|${c.title}`.trim().toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    };
    return [...live, ...lead, ...rest].filter(uniq);
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
  // Waving Sri Lanka flag for the hero. Markup only - the wave and the sheen are
  // pure CSS (.sl-flag in styles.css), and the same class is used on the
  // sign-in gate so there is one definition of the animation.
  function flagHtml() {
    return `<span class="sl-flag" role="img" aria-label="Sri Lanka"></span>`;
  }

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
    // Waving Sri Lanka flag. The wave + sheen are pure CSS (see .sl-flag in
    // styles.css); the markup is shared with the sign-in gate.
    view.innerHTML = `
      <section class="home-hero">
        <div class="home-hero-logo" style="background-image:url('assets/brand-logo.jpeg')"></div>
        <h1 class="home-hero-title">HC COMMUNITY</h1>
        <p class="home-hero-flagline">
          ${flagHtml()}
          <span class="home-hero-country">SRI LANKA</span>
        </p>
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
