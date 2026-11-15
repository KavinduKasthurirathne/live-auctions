/* ============================================================
   Hall of Fame + player profiles  (renders into #view-halloffame)

   READ-ONLY. Everything here is derived from data the site already has:
     - the tournaments registry (window.HCCLSeries) for what exists and
       its recorded honours (champion / runner-up / MVP),
     - the season archive (window.HCCLSeasonArchive) for HCCL season
       honours, logos, photos and the stats sheets,
     - cloud-imported tournament stats sheets, fetched once per session
       through app.js loadCareerExtraSheets() (signed-in users only).
   Nothing is written anywhere, and nothing is invented: a figure with no
   sheet behind it shows as "-".

   It also owns the "honour card" builder that Home reuses (one card per
   tournament: logo, name, champion, runner-up, MVP, leaders). That logic
   moved here unchanged from home.js - twin registry entries are merged,
   HCCL seasons fall back to the bundled archive, leaders come from the
   stats sheet first.

   Public: window.HCCLHallOfFame = { honorCards, honorCardHtml,
           featured, openPlayer, render }
   ============================================================ */
(function () {
  "use strict";

  const pad2 = n => String(n).padStart(2, "0");
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ic = (n, c) => (window.HCCLUI ? window.HCCLUI.icon(n, c) : "");
  const keyOf = n => String(n || "").trim().toLowerCase().replace(/\s+/g, " ");
  const same = (a, b) => !!a && !!b && keyOf(a) === keyOf(b);
  const PLACEHOLDER = /^(|tbd|tba|-+|\?|n\/a)$/i;
  const real = v => !PLACEHOLDER.test(String(v || "").trim());

  const archive = () => window.HCCLSeasonArchive || null;
  const series = () => window.HCCLSeries || null;

  /* Dates parsed from the duration string - ONE parser, owned by series.js. */
  const startStamp = d => (window.HCCLSeries && window.HCCLSeries.durationStart)
    ? window.HCCLSeries.durationStart(d) : Infinity;
  const endStamp = d => (window.HCCLSeries && window.HCCLSeries.durationEnd)
    ? window.HCCLSeries.durationEnd(d) : -Infinity;

  /* ===================== honour cards (shared with Home) ===================== */
  // A tournament can end up in the registry TWICE (a hand-created entry plus
  // the bundled seed for the same event). Fold each pair into one entry: field
  // by field, the first twin that HAS a value wins, and a twin carrying a
  // champion leads. The Tournaments tab still lists both (DUPLICATE chip).
  function mergeTwins(list, S) {
    if (!S || !S.identityKey) return list.map(t => ({ ...t, ids: [t.id] }));
    const groups = new Map();
    list.forEach(t => {
      const k = S.identityKey(t) || t.id;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    });
    const pick = (...vals) => vals.find(v => v !== "" && v != null && v !== false) ?? "";
    return [...groups.values()].map(g => {
      if (g.length === 1) return { ...g[0], ids: [g[0].id] };
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
      merged.ids = sorted.map(t => t.id);
      return merged;
    });
  }

  // One plain object per tournament - the data, not the markup.
  function honorCards() {
    const A = archive();
    const S = series();
    if (!A) return [];
    // HCCL season number: the registry's own rule (series.js hcclSeasonNo), so a
    // season an admin created by hand ("HCCL Season 07", no archive tag) still
    // files under HC Champions League. Only the seasons the bundled archive
    // actually holds read their stats from it; a newer season with live data
    // roots uses its own imported sheet like any other tournament.
    const seasonNoOf = t => (S && S.hcclSeasonNo ? S.hcclSeasonNo(t) : (t.season || (t.legacy ? 6 : 0)));
    const inArchive = no => !!no && A.seasons().some(s => s.no === no);
    // The archive has a stats SHEET for this season (bundled CSV or a live
    // override) - an authored entry alone (honours typed into SEASONS) isn't one.
    const archiveRows = no => (inArchive(no) && A.seasonRows ? (A.seasonRows(no) || []) : []);

    // The registry is the source of truth; if it never loaded, fall back to
    // the bundled archive so the story is still told.
    const raw = S ? S.list() : A.seasons().map(s => ({
      id: `hccl-s${s.no}`, name: `HCCL Season ${pad2(s.no)}`,
      archive: "hccl", season: s.no, duration: s.year || "",
      status: s.ongoing ? "live" : "completed",
      honors: { champion: s.champion, runnerUp: s.runnerUp, mvp: s.mvp },
    }));
    const list = mergeTwins(raw, S);

    // Most Runs / Most Wickets: an HCCL season from its own stats sheet; any
    // other tournament from its imported/bundled sheet, falling back to the
    // honours fields an editor typed.
    const leadersOf = t => {
      const no = seasonNoOf(t);
      // An archived season with its own sheet: derived from it (seasons 1-6).
      if (archiveRows(no).length) return A.leaders(no);
      // Otherwise (other tournaments, or a newer HCCL season run with live
      // data roots): its imported / bundled sheet, else the honours fields.
      const h = t.honors || {};
      const lead = { mostRuns: h.mostRuns || "", mostWickets: h.mostWickets || "" };
      const csv = A.tournamentCsv ? A.tournamentCsv(t.id, t.name) : null;
      if (csv) {
        const der = A.leadersFromRows(A.rowsFromCsv(csv));
        lead.mostRuns = der.mostRuns || lead.mostRuns;
        lead.mostWickets = der.mostWickets || lead.mostWickets;
      }
      // Last resort: values authored for that season in the archive.
      if (inArchive(no)) {
        const al = A.leaders(no);
        lead.mostRuns = lead.mostRuns || al.mostRuns;
        lead.mostWickets = lead.mostWickets || al.mostWickets;
      }
      return lead;
    };

    const seen = new Set();
    const cards = [];
    list.forEach(t => {
      const no = seasonNoOf(t);
      const s = no ? (A.seasons().find(x => x.no === no) || null) : null;
      const rh = t.honors || {};
      const c = {
        id: t.id, ids: t.ids || [t.id], name: t.name,
        seasonNo: no, archived: archiveRows(no).length > 0, solo: !!t.solo, status: t.status, live: t.status === "live",
        league: no ? "HC Champions League" : "",
        title: no ? `Season ${pad2(no)}` : t.name,
        duration: t.duration || "",
        start: startStamp(t.duration), end: endStamp(t.duration),
        logo: (A.logoFor ? A.logoFor(t.logo, t.name, no)
          : t.logo || (no ? A.seasonLogo(no) : (A.tournamentLogo && A.tournamentLogo(t.name)))) || "",
        honors: {
          champion: rh.champion || (s && s.champion) || "",
          runnerUp: rh.runnerUp || (s && s.runnerUp) || "",
          mvp: rh.mvp || (s && s.mvp) || "",
        },
        lead: leadersOf(t),
      };
      // Belt & braces behind mergeTwins(): identical league+title collapses.
      const k = `${c.league}|${c.title}`.trim().toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      cards.push(c);
    });
    return cards;
  }

  // Newest first: live ones lead, then by end date, undated (upcoming) last.
  // Compared with < / > - undated stamps are ±Infinity and subtraction NaNs.
  function byRecent(a, b) {
    if (a.live !== b.live) return a.live ? -1 : 1;
    if (a.end === b.end) return a.start === b.start ? 0 : (a.start > b.start ? -1 : 1);
    return a.end > b.end ? -1 : 1;
  }

  // Home's featured card: the live tournament (earliest-started if several),
  // else the most recently finished one.
  function featured(cards) {
    const list = cards || honorCards();
    const live = list.filter(c => c.live).sort((a, b) => (a.start === b.start ? 0 : a.start < b.start ? -1 : 1));
    if (live.length) return live[0];
    const done = list.filter(c => c.status !== "upcoming" && c.end > -Infinity);
    return done.length ? done.reduce((best, c) => (c.end > best.end ? c : best), done[0]) : (list[0] || null);
  }

  function logoBlock(cls, img, name) {
    if (img) return `<div class="${cls}" style="background-image:url('${img}')" role="img" aria-label="${esc(name)}"></div>`;
    const initials = esc(String(name || "?").trim().split(/\s+/).map(w => w[0]).join("").slice(0, 3).toUpperCase());
    return `<div class="${cls}">${initials}</div>`;
  }
  const playerAttr = name => (real(name) ? ` data-player="${esc(String(name).trim())}" role="button" tabindex="0"` : "");

  function honorRow(cls, icon, label, kind, value) {
    const A = archive();
    if (!real(value)) return "";
    const attr = kind === "player" ? playerAttr(value) : "";
    return `<li class="honor-row ${cls}"${attr}>
      <span class="honor-k">${ic(icon, "sm")}${esc(label)}</span>
      ${A ? A.bubble(kind, value) : ""}
      <span class="honor-v">${esc(value)}</span>
    </li>`;
  }

  function honorCardHtml(c) {
    const h = c.honors || {};
    const what = c.seasonNo ? "Season" : "Tournament";
    const note = (head, sub) => `<div class="honor-note"><b>${esc(head)}</b><span>${esc(sub)}</span></div>`;
    const chip = c.live
      ? `<span class="chip live"><span class="live-dot"></span>Live</span>`
      : c.status === "upcoming" ? `<span class="chip upcoming">Upcoming</span>` : "";
    let body;
    if (real(h.champion)) {
      const kind = c.solo ? "player" : "team";
      const leadsDone = !c.live; // a live tournament's leaders aren't honours yet
      body = `<ul class="honor-list">
        ${honorRow("is-champion", "crown", "Champion", kind, h.champion)}
        ${honorRow("", "medal", "Runner-up", kind, h.runnerUp)}
        ${honorRow("", "star", "MVP", "player", h.mvp)}
        ${leadsDone ? honorRow("", "zap", "Most runs", "player", c.lead && c.lead.mostRuns) : ""}
        ${leadsDone ? honorRow("", "target", "Most wickets", "player", c.lead && c.lead.mostWickets) : ""}
      </ul>`;
    } else if (c.live) {
      const lead = c.lead || {};
      const leaders = (real(lead.mostRuns) || real(lead.mostWickets)) ? `<ul class="honor-list">
        ${honorRow("", "zap", "Top scorer", "player", lead.mostRuns)}
        ${honorRow("", "target", "Top wicket-taker", "player", lead.mostWickets)}
      </ul>` : "";
      body = note(`${what} in progress`, "Champion crowned soon - follow it in Tournaments") + leaders;
    } else if (c.status === "upcoming") {
      body = note("Coming soon", `This ${what.toLowerCase()} hasn't been played yet`);
    } else {
      body = note("Champion to be confirmed", "The honours for this one aren't recorded yet");
    }
    return `<article class="honor-card${c.live ? " live" : ""}">
      <header class="honor-head">
        ${logoBlock("honor-logo", c.logo, c.title)}
        <div class="honor-meta">
          ${c.league ? `<span class="honor-league">${esc(c.league)}</span>` : ""}
          <h3 class="honor-name">${esc(c.title)}</h3>
          ${c.duration ? `<span class="honor-dur">${esc(c.duration)}</span>` : ""}
        </div>
        ${chip}
      </header>
      ${body}
    </article>`;
  }

  /* ===================== player stats (effective sheets) ===================== */
  let cloudSheets = null;      // [{ id, name, csv }] once fetched
  let cloudLoading = false;
  function ensureCloudSheets() {
    if (cloudSheets || cloudLoading) return;
    const H = window.HCCL;
    if (typeof window.loadCareerExtraSheets !== "function" || !H || !H.configured || !H.user) return;
    cloudLoading = true;
    window.loadCareerExtraSheets()
      .then(list => { cloudSheets = Array.isArray(list) ? list : []; })
      .catch(() => { cloudSheets = []; })
      .then(() => { cloudLoading = false; invalidate(); scheduleRender(); });
  }

  // ONE sheet per tournament: the cloud import if there is one, else the
  // bundled copy; HCCL seasons use their own (live-overridable) season sheet.
  // Identical sheet text reached twice is only counted once.
  function effectiveSheets(cards) {
    const A = archive();
    if (!A) return [];
    const cloudById = new Map((cloudSheets || []).filter(x => x && x.id && x.csv).map(x => [x.id, x.csv]));
    const usedCsv = new Set();
    const out = [];
    cards.forEach(c => {
      let rows = null;
      if (c.archived && A.seasonRows) {
        rows = A.seasonRows(c.seasonNo);
      } else {
        const ids = c.ids || [c.id];
        let csv = ids.map(id => cloudById.get(id)).find(Boolean) || null;
        if (!csv && A.tournamentCsv) csv = ids.map(id => A.tournamentCsv(id, c.name)).find(Boolean) || null;
        if (csv) {
          if (usedCsv.has(csv)) return;
          usedCsv.add(csv);
          rows = A.rowsFromCsv(csv);
        }
      }
      if (rows && rows.length) out.push({ id: c.id, name: c.seasonNo ? `HCCL ${c.title}` : c.title, rows, card: c });
    });
    return out;
  }

  // Cached model, rebuilt when the registry / archive / cloud sheets change.
  let model = null;
  function invalidate() { model = null; }
  function getModel() {
    if (model) return model;
    const A = archive();
    const cards = honorCards();
    const sheets = effectiveSheets(cards);
    const players = A && A.statLines ? A.statLines(sheets) : new Map();
    model = { cards, sheets, players, pairs: pairMembers(cards, players) };
    return model;
  }

  /* ===================== duo / tag-team names ("Kalana & Nehan") =====================
     A Tag Team Championship crowns a PAIR, and the pair's name is made of its
     players' names. Nothing else records who was in it, so the members are
     read from the name: each part maps to a player when it points at exactly
     ONE person - the full name, or a first name only one player carries
     (spelling variants of one person - "Anjana"/"Anajana", "Thenu"/"Thenuja" -
     count as one). A first name two different players share is never guessed. */
  const PAIR_SPLIT = /\s*(?:&|\+|\/|,|\band\b|\s[x×]\s)\s*/i;
  const PAIRS_EVENT = /tag\s*team|doubles|\bpairs?\b|\bduos?\b/i;
  const pairParts = name => {
    const parts = String(name || "").split(PAIR_SPLIT).map(s => s.trim()).filter(Boolean);
    return parts.length >= 2 ? parts : [];
  };
  const tokens = n => keyOf(n).split(" ").filter(Boolean);
  function editDistance(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return d[a.length][b.length];
  }
  // Two surnames that are one person's spelling variants.
  function sameSurname(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    if (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
    return Math.min(a.length, b.length) >= 5 && editDistance(a, b) <= 2;
  }
  // Group full names (2+ words) by person: same first name + variant surname.
  function people(names) {
    const groups = [];
    names.forEach(n => {
      const t = tokens(n);
      const g = groups.find(x => x.first === t[0] && sameSurname(x.last, t[t.length - 1]));
      if (g) g.keys.add(keyOf(n)); else groups.push({ first: t[0], last: t[t.length - 1], keys: new Set([keyOf(n)]) });
    });
    return groups;
  }
  // card id + "|champion" / "|runnerUp" -> Set of player keys in that pair.
  function pairMembers(cards, players) {
    const out = new Map();
    // Every name we know, so a shared first name is spotted even when the
    // other player has no stats yet (bundled photos, cloud photo library).
    const known = new Set([...players.values()].map(p => p.name));
    const AM = window.HCCL_ASSETS || {};
    Object.values(AM.playerPhotoIndex || {}).forEach(p => {
      let f = String(p).split("/").pop().replace(/\.[^.]+$/, "");
      try { f = decodeURI(f); } catch (e) { /* plain */ }
      known.add(f);
    });
    const L = window.HCCLPhotoLib;
    if (L && typeof L.list === "function") L.list().forEach(e => e && e.name && known.add(e.name));
    const groups = people([...known].filter(n => tokens(n).length >= 2));

    const resolve = part => {
      const k = keyOf(part), t = tokens(part);
      const hits = new Set();
      if (players.has(k)) hits.add(k);                       // exact profile ("Nehan", or a full name)
      const mine = t.length >= 2
        ? groups.filter(g => g.first === t[0] && sameSurname(g.last, t[t.length - 1]))  // full name, any spelling
        : groups.filter(g => g.first === t[0]);                                          // first name only
      if (mine.length === 1) mine[0].keys.forEach(x => { if (players.has(x)) hits.add(x); });
      return hits;
    };

    cards.forEach(c => {
      const h = c.honors || {};
      const pairsEvent = PAIRS_EVENT.test(`${c.name || ""} ${c.title || ""}`);
      ["champion", "runnerUp"].forEach(role => {
        const parts = pairParts(h[role]);
        if (!parts.length) return;
        const each = parts.map(resolve);
        // A Tag Team / doubles event: credit every part we can pin down. Any
        // other event: only when EVERY part is a known player - so an ordinary
        // team called "Knights & Kings" never credits anyone.
        if (!pairsEvent && each.some(s => !s.size)) return;
        const set = new Set();
        each.forEach(s => s.forEach(x => set.add(x)));
        if (set.size) out.set(`${c.id}|${role}`, set);
      });
    });
    return out;
  }

  /* ===================== records ===================== */
  function topCount(values) {
    const counts = new Map();
    values.filter(real).forEach(v => {
      const k = keyOf(v);
      const e = counts.get(k) || { name: String(v).trim(), n: 0 };
      e.n++; counts.set(k, e);
    });
    let best = [];
    counts.forEach(e => {
      if (!best.length || e.n > best[0].n) best = [e];
      else if (e.n === best[0].n) best.push(e);
    });
    return best;
  }

  function recordsHtml(m) {
    const A = archive();
    const done = m.cards.filter(c => real(c.honors.champion));
    const cards = [];
    const rec = (icon, label, who, kind, n, unit) => {
      if (!who.length) return;
      const names = who.map(w => w.name);
      const bubble = A ? (kind === "team" ? A.bubble("team", names[0]) : A.bubble("player", names[0])) : "";
      const attr = kind === "player" && names.length === 1 ? playerAttr(names[0]) : "";
      cards.push(`<div class="record-card"${attr}>
        ${bubble || `<span class="record-ico">${ic(icon)}</span>`}
        <div class="record-body">
          <span class="record-k">${esc(label)}</span>
          <span class="record-v" title="${esc(names.join(" · "))}">${esc(names.join(" · "))}</span>
          <span class="record-n">${esc(n)} ${esc(unit)}</span>
        </div>
      </div>`);
    };
    // Titles: team champions (solo events crown a player - counted separately).
    const teamTitles = topCount(done.filter(c => !c.solo).map(c => c.honors.champion));
    if (teamTitles.length && teamTitles[0].n >= 2) rec("crown", "Most titles", teamTitles, "team", teamTitles[0].n, "titles");
    const mvps = topCount(done.map(c => c.honors.mvp));
    if (mvps.length && mvps[0].n >= 2) rec("star", "Most MVP awards", mvps, "player", mvps[0].n, "awards");
    // Career aggregates across every published sheet.
    let runs = [], wkts = [];
    m.players.forEach(p => {
      const t = A.careerTotals(p.lines);
      if (t.runs > 0) {
        if (!runs.length || t.runs > runs[0].v) runs = [{ name: p.name, v: t.runs }];
        else if (t.runs === runs[0].v) runs.push({ name: p.name, v: t.runs });
      }
      if (t.wickets > 0) {
        if (!wkts.length || t.wickets > wkts[0].v) wkts = [{ name: p.name, v: t.wickets }];
        else if (t.wickets === wkts[0].v) wkts.push({ name: p.name, v: t.wickets });
      }
    });
    if (runs.length) rec("zap", "Most career runs", runs, "player", runs[0].v.toLocaleString(), "runs");
    if (wkts.length) rec("target", "Most career wickets", wkts, "player", wkts[0].v.toLocaleString(), "wickets");
    return cards.length ? `<section class="hof-records" aria-label="Records">${cards.join("")}</section>` : "";
  }

  /* ===================== page ===================== */
  const UI = { tab: "champions", group: "all", q: "", limit: 48, player: null };
  const PAGE = 48;

  function championsHtml(m) {
    const groups = [
      { key: "all", label: "All", test: () => true },
      { key: "hccl", label: "HC Champions League", test: c => !!c.seasonNo },
      { key: "other", label: "Other tournaments", test: c => !c.seasonNo },
    ];
    const g = groups.find(x => x.key === UI.group) || groups[0];
    const list = m.cards.filter(g.test).slice().sort(byRecent);
    return `
      <div class="filter-row" role="group" aria-label="Filter tournaments">
        ${groups.map(x => `<button class="filter-chip${x.key === g.key ? " active" : ""}" data-hof-group="${x.key}" aria-pressed="${x.key === g.key}">
          ${esc(x.label)} <span class="count">${m.cards.filter(x.test).length}</span></button>`).join("")}
      </div>
      ${list.length ? `<div class="honor-grid">${list.map(honorCardHtml).join("")}</div>`
        : `<div class="hub-empty"><h3>Nothing here yet</h3><p>Honours appear once a tournament records its champion.</p></div>`}`;
  }

  function playersHtml(m) {
    const A = archive();
    const q = keyOf(UI.q);
    const all = [...m.players.entries()]
      .map(([k, p]) => ({ k, p }))
      .sort((a, b) => a.p.name.localeCompare(b.p.name));
    const hits = q ? all.filter(x => x.k.includes(q)) : all;
    const shown = hits.slice(0, UI.limit);
    const grid = shown.length ? `<div class="player-grid">${shown.map(({ p }) => {
      const tn = new Set(p.lines.map(l => l.id)).size;
      return `<button class="player-tile" data-player="${esc(p.name)}">
        ${A ? A.bubble("player", p.name) : ""}
        <b>${esc(p.name)}</b>
        <span>${tn} tournament${tn === 1 ? "" : "s"}</span>
      </button>`;
    }).join("")}</div>` : `<div class="hub-empty"><h3>No players found</h3><p>${q ? "Try a different spelling." : "Players appear once a stats sheet is published."}</p></div>`;
    return `
      <div class="hof-bar">
        <label class="hof-search"><span class="sr-only">Search players</span>
          <input type="search" id="hofSearch" placeholder="Search ${all.length} players…" value="${esc(UI.q)}" autocomplete="off" />
        </label>
        <span class="hint">${hits.length} player${hits.length === 1 ? "" : "s"} · alphabetical</span>
      </div>
      ${grid}
      ${hits.length > shown.length ? `<div class="hof-more"><button class="btn btn-dark" data-hof-more>Show more (${hits.length - shown.length})</button></div>` : ""}`;
  }

  /* ---- profile ---- */
  function honoursFor(m, p) {
    const out = [];
    const me = keyOf(p.name);
    m.cards.forEach(c => {
      const h = c.honors || {};
      const line = p.lines.find(l => l.id === c.id);
      const where = c.seasonNo ? `HCCL ${c.title}` : c.title;
      const team = line && line.team;
      // In the pair named by this tournament's champion / runner-up?
      const inPair = role => { const s = m.pairs && m.pairs.get(`${c.id}|${role}`); return !!s && s.has(me); };
      const place = (role, gold, icon, label) => {
        const won = h[role];
        if (!real(won)) return;
        if (c.solo && same(won, p.name)) out.push({ gold, icon, title: label, sub: where });
        else if ((!c.solo && team && same(won, team)) || inPair(role)) {
          out.push({ gold, icon, title: `${label} with ${String(won).trim()}`, sub: where });
        }
      };
      place("champion", true, "crown", "Champion");
      place("runnerUp", false, "medal", "Runner-up");
      if (same(h.mvp, p.name)) out.push({ gold: true, icon: "star", title: "Most Valuable Player", sub: where });
      if (!c.live && c.lead) {
        if (same(c.lead.mostRuns, p.name)) out.push({ icon: "zap", title: "Most runs", sub: where });
        if (same(c.lead.mostWickets, p.name)) out.push({ icon: "target", title: "Most wickets", sub: where });
      }
    });
    return out;
  }

  function roleOf(name) {
    const AU = window.HCCLAuction;
    if (!AU || typeof AU.players !== "function") return "";
    const hit = AU.players().find(x => same(x.name, name));
    return hit && hit.role ? hit.role : "";
  }

  function profileHtml(m, key) {
    const A = archive();
    const back = `<button class="btn btn-ghost profile-back" data-hof-back>${ic("chevron-left")}<span>Hall of Fame</span></button>`;
    const p = m.players.get(key);
    if (!p) {
      return `${back}<div class="hub-empty"><h3>No published stats for this player</h3>
        <p>Profiles are built from tournament stats sheets - this name doesn't appear in any of them yet.</p></div>`;
    }
    const t = A.careerTotals(p.lines);
    const photo = A.playerPhoto ? A.playerPhoto(p.name) : "";
    const initial = esc((p.name.trim()[0] || "?").toUpperCase());
    const teams = [];
    p.lines.forEach(l => { if (l.team && !teams.some(x => same(x, l.team))) teams.push(l.team); });
    const role = roleOf(p.name);
    const tile = (k, v, sub) => `<div class="stat-tile"><span class="stat-k">${esc(k)}</span><span class="stat-v">${esc(v)}</span>${sub ? `<span class="stat-sub">${esc(sub)}</span>` : ""}</div>`;
    const dash = "-";
    const honours = honoursFor(m, p);
    const order = new Map(m.cards.slice().sort(byRecent).map((c, i) => [c.id, i]));
    const lines = p.lines.slice().sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
    return `${back}
      <div class="profile-stack">
        <section class="card profile-hero">
          <div class="profile-photo"${photo ? ` style="background-image:url('${photo}')" role="img" aria-label="${esc(p.name)}"` : ` style="background:var(--accent-soft);color:var(--accent-2)"`}>${photo ? "" : initial}</div>
          <div>
            <p class="eyebrow">Player profile</p>
            <h2 class="profile-name">${esc(p.name)}</h2>
            <div class="profile-tags">
              ${role ? `<span class="chip">${esc(role)}</span>` : ""}
              ${teams.map(tm => `<span class="team-chip"><i style="${A.teamLogo(tm) ? `background-image:url('${A.teamLogo(tm)}')` : ""}"></i>${esc(tm)}</span>`).join("")}
            </div>
          </div>
        </section>
        <section class="stat-tiles six" aria-label="Career statistics">
          ${(n => tile("Matches", t.matches || dash, `${n} tournament${n === 1 ? "" : "s"}`))(new Set(p.lines.map(l => l.id)).size)}
          ${tile("Runs", t.runs.toLocaleString())}
          ${tile("Wickets", t.wickets.toLocaleString())}
          ${tile("Average", t.batted ? t.average : dash, "batting")}
          ${tile("Strike rate", t.batted ? t.strikeRate : dash)}
          ${tile("Economy", t.bowled ? t.economy : dash, "per over")}
        </section>
        <section class="card">
          <h3>Honours</h3>
          ${honours.length ? `<ul class="honours">${honours.map(h => `<li class="honour${h.gold ? " gold" : ""}">
              <span class="honour-ico">${ic(h.icon)}</span>
              <div><b>${esc(h.title)}</b><span>${esc(h.sub)}</span></div></li>`).join("")}</ul>`
            : `<p class="hint">No recorded honours yet.</p>`}
        </section>
        <section class="card">
          <h3>By tournament</h3>
          <div class="lb-scroll"><table class="data-table pin">
            <thead><tr><th>Tournament</th><th>Team</th><th class="num">M</th><th class="num">Runs</th><th class="num">Wkts</th></tr></thead>
            <tbody>${lines.map(l => `<tr><td>${esc(l.tournament)}</td><td>${esc(l.team || dash)}</td>
              <td class="num">${l.matches || dash}</td><td class="num">${l.runs}</td><td class="num">${l.wickets}</td></tr>`).join("")}</tbody>
          </table></div>
          <p class="hint">Career figures add up every published tournament stats sheet${cloudSheets ? "" : " bundled with the site"}; averages are re-derived from the raw totals.</p>
        </section>
      </div>`;
  }

  function render() {
    const view = document.getElementById("view-halloffame");
    if (!view) return;
    if (!archive()) { view.innerHTML = `<div class="hub-empty"><h3>Hall of Fame unavailable</h3><p>The season archive didn't load - try reloading the page.</p></div>`; return; }
    if (view.classList.contains("active")) ensureCloudSheets();
    const m = getModel();
    if (UI.player) { view.innerHTML = profileHtml(m, UI.player); return; }
    view.innerHTML = `
      <div class="view-head">
        <div><p class="eyebrow">Honours &amp; records</p><h2>Hall of Fame</h2></div>
      </div>
      ${recordsHtml(m)}
      <div class="segmented hof-tabs" role="tablist" aria-label="Hall of Fame sections" style="margin-bottom:var(--s-4)">
        <button class="seg-btn${UI.tab === "champions" ? " active" : ""}" data-hof-tab="champions" role="tab" aria-selected="${UI.tab === "champions"}">Champions</button>
        <button class="seg-btn${UI.tab === "players" ? " active" : ""}" data-hof-tab="players" role="tab" aria-selected="${UI.tab === "players"}">Players</button>
      </div>
      <div class="hof-panel">${UI.tab === "players" ? playersHtml(m) : championsHtml(m)}</div>`;
  }

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  // Open a profile from anywhere ([data-player] on podiums, leaders, tables).
  function openPlayer(name) {
    UI.player = keyOf(name);
    if (typeof window.switchTab === "function") window.switchTab("halloffame");
    render();
    window.scrollTo(0, 0);
    if (window.HCCL && window.HCCL.track) window.HCCL.track("select_content", { content_type: "player_profile" });
  }

  function onClick(e) {
    const t = e.target;
    const pl = t.closest("[data-player]");
    if (pl) { openPlayer(pl.getAttribute("data-player")); return; }
    // Shortcuts elsewhere (Home's "Hall of Fame" buttons) land on the main
    // page, never on a profile left open earlier. app.js's [data-goto]
    // handler has already switched the tab by the time this runs.
    if (t.closest('[data-goto="halloffame"]')) { UI.player = null; scheduleRender(); return; }
    const view = document.getElementById("view-halloffame");
    if (!view || !view.contains(t)) return;
    if (t.closest("[data-hof-back]")) { UI.player = null; render(); window.scrollTo(0, 0); return; }
    const tab = t.closest("[data-hof-tab]");
    if (tab) { UI.tab = tab.getAttribute("data-hof-tab"); render(); return; }
    const grp = t.closest("[data-hof-group]");
    if (grp) { UI.group = grp.getAttribute("data-hof-group"); render(); return; }
    if (t.closest("[data-hof-more]")) { UI.limit += PAGE; render(); }
  }

  function onKey(e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    const pl = e.target.closest && e.target.closest('[data-player][role="button"]');
    if (!pl) return;
    e.preventDefault();
    openPlayer(pl.getAttribute("data-player"));
  }

  let searchTimer = null;
  function onInput(e) {
    if (e.target.id !== "hofSearch") return;
    clearTimeout(searchTimer);
    const val = e.target.value;
    searchTimer = setTimeout(() => {
      UI.q = val; UI.limit = PAGE;
      render();
      const inp = document.getElementById("hofSearch");
      if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    }, 150);
  }

  function init() {
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    document.addEventListener("input", onInput);
    const changed = () => { invalidate(); scheduleRender(); };
    if (archive()) archive().onChange(changed);
    if (series()) series().onChange(changed);
    if (window.HCCL && typeof window.HCCL.onChange === "function") window.HCCL.onChange(changed);
    // Opening the tab from the nav lands on the main page (not a stale profile).
    const tabs = document.getElementById("tabs");
    if (tabs) tabs.addEventListener("click", e => {
      if (e.target.closest('[data-tab="halloffame"]')) { UI.player = null; scheduleRender(); }
    });
    render();
  }

  window.HCCLHallOfFame = { honorCards, honorCardHtml, featured, byRecent, openPlayer, render };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
