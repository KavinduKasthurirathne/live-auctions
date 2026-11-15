/* ============================================================
   HC Community Home page  (renders into #view-home)

   Landing view after sign-in:
     1. Hero - league logo, name, tagline and three shortcuts.
     2. Featured tournament - the LIVE one (or, with none live, the most
        recently finished) with quick links into its tournament page.
     3. Recent champions - the latest honour cards in a static grid, with a
        link to the full Hall of Fame. (This replaced the auto-sliding
        carousel: nothing moves on its own, and the grid scans faster.)

   The honour-card data + markup come from js/hall-of-fame.js
   (window.HCCLHallOfFame), the same builder the Hall of Fame page uses, so
   the two can never disagree. This module only reads; it re-renders when
   the registry, the archive or auth report a change.
   ============================================================ */
(function () {
  "use strict";

  const RECENT_COUNT = 6;
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ic = (n, c) => (window.HCCLUI ? window.HCCLUI.icon(n, c) : "");
  const hof = () => window.HCCLHallOfFame || null;
  const series = () => window.HCCLSeries || null;
  const archive = () => window.HCCLSeasonArchive || null;

  function logoBlock(img, name) {
    if (img) return `<div class="live-logo" style="background-image:url('${img}')" role="img" aria-label="${esc(name)}"></div>`;
    const initials = esc(String(name || "?").trim().split(/\s+/).map(w => w[0]).join("").slice(0, 3).toUpperCase());
    return `<div class="live-logo">${initials}</div>`;
  }

  // The featured card: the live tournament, else the latest finished one.
  function featuredHtml(c) {
    if (!c) return "";
    const S = series();
    const meta = S && S.list ? S.list().find(t => (c.ids || [c.id]).includes(t.id)) : null;
    const hasRoots = !!(meta && S.hasDataRoots && S.hasDataRoots(meta.id));
    const hasAuction = !!(S && S.hasAuction && meta && S.hasAuction(meta.id));
    const sub = [
      c.live ? `<span class="chip live"><span class="live-dot"></span>Live</span>` : `<span class="chip">Latest</span>`,
      c.duration ? `<span>${esc(c.duration)}</span>` : "",
      !c.live && c.honors && c.honors.champion ? `<span>${ic("crown", "sm")} ${esc(c.honors.champion)}</span>` : "",
    ].join("");
    const link = (hub, icon, label, extra) =>
      `<button class="btn btn-dark" data-home-open="${esc(c.id)}" data-home-hub="${hub}"${extra || ""}>${ic(icon)}<span>${label}</span></button>`;
    return `<section class="section" aria-labelledby="homeFeaturedTitle">
      <div class="section-head"><h2 class="section-title" id="homeFeaturedTitle">${c.live ? "Live now" : "Latest tournament"}</h2></div>
      <article class="live-card${c.live ? " is-live" : ""}">
        ${logoBlock(c.logo, c.title)}
        <div class="live-meta">
          ${c.league ? `<span class="honor-league">${esc(c.league)}</span>` : ""}
          <h3>${esc(c.seasonNo ? c.title : c.name)}</h3>
          <div class="live-sub">${sub}</div>
        </div>
        <div class="live-links">
          ${link("overview", "layout-grid", "Overview")}
          ${link("squads", "shield", "Squads")}
          ${hasRoots ? link("fantasy", "star", "Fantasy") : link("stats", "chart-column", "Stats")}
          ${hasRoots && hasAuction && c.live ? link("auction", "gavel", "Auction room", " data-home-auction") : ""}
        </div>
      </article>
    </section>`;
  }

  function recentHtml(cards, featured) {
    const H = hof();
    const list = cards
      .filter(c => c !== featured && c.honors && c.honors.champion)
      .sort(H.byRecent)
      .slice(0, RECENT_COUNT);
    if (!list.length) return "";
    return `<section class="section" aria-labelledby="homeChampsTitle">
      <div class="section-head">
        <h2 class="section-title" id="homeChampsTitle">${ic("trophy")}Recent champions</h2>
        <button class="link-btn" data-goto="halloffame">Hall of Fame ${ic("chevron-right", "sm")}</button>
      </div>
      <div class="honor-grid home-recent">${list.map(H.honorCardHtml).join("")}</div>
    </section>`;
  }

  function render() {
    const view = document.getElementById("view-home");
    if (!view) return;
    const H = hof();
    const cards = H && archive() ? H.honorCards() : [];
    const featured = H ? H.featured(cards) : null;
    view.innerHTML = `
      <section class="home-hero">
        <div class="home-hero-inner">
          <div class="home-hero-logo" style="background-image:url('assets-web/brand-logo.webp')" role="img" aria-label="HC Community logo"></div>
          <div class="home-hero-copy">
            <p class="home-hero-flagline eyebrow">
              <span class="sl-flag" role="img" aria-label="Sri Lanka"></span>
              <span class="home-hero-country">Sri Lanka</span>
            </p>
            <h1 class="home-hero-title">HC Community</h1>
            <p class="home-hero-sub">A place where hand cricket champions shine</p>
            <p class="home-hero-tags">Live Auctions · Fantasy League · Season Stats</p>
            <div class="home-hero-cta">
              <button class="btn btn-yellow" data-goto="series">${ic("trophy")}<span>Tournaments</span></button>
              <button class="btn btn-dark" data-goto="fantasy">${ic("star")}<span>Play Fantasy</span></button>
              <button class="btn btn-ghost" data-goto="halloffame">${ic("award")}<span>Hall of Fame</span></button>
            </div>
          </div>
        </div>
      </section>
      ${featuredHtml(featured)}
      ${H ? recentHtml(cards, featured) : ""}`;
  }

  // Featured-card shortcuts: open that tournament's page on the chosen tab.
  function onHomeClick(e) {
    const b = e.target.closest("[data-home-open]");
    if (!b) return;
    const id = b.getAttribute("data-home-open");
    const hub = b.getAttribute("data-home-hub") || "overview";
    const S = series();
    if (!S || typeof window.switchTab !== "function") return;
    if (hub === "auction") {
      if (S.open) S.open(id, "overview");
      if (typeof window.goAuctions === "function") window.goAuctions("auction");
      return;
    }
    window.switchTab("series");
    if (S.open) S.open(id, hub);
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
