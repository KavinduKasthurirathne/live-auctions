/* ============================================================
   HCCL Series - multi-tournament registry + the 🏆 Series page.

   Firestore layout:
     tournaments/{tid}          meta: { name, short, logo, duration,
                                status: upcoming|live|completed,
                                legacy?, order, createdAt }
     tournaments/_config        { activeId }  (what visitors land on)

   Every tournament-bound module (auction, fantasy, fixtures, MVP)
   asks THIS module for its data-path prefix:
     prefix() -> []                      for the legacy tournament
                 ["tournaments", tid]    for everything else
   The legacy tournament (HCCL Season 6) keeps reading/writing the
   ORIGINAL roots (auction/league, fantasy/league, mvp, matches) -
   zero data movement for the live season.

   If the registry can't be read (rules not published yet, offline),
   we fall back to a single legacy tournament and the app behaves
   exactly as it did before this feature existed.

   Loads right after app.js and reuses its globals ($, toast, esc,
   fileToDataURL, switchTab).
   ============================================================ */
(function () {
  "use strict";

  const LEGACY_ID = "hccl-s6";
  const VIEW_KEY = "hccl_viewing_tournament";
  // The legacy entry is HCCL Season 06 - the LIVE season whose data stays at
  // the ORIGINAL Firestore roots (auction/fantasy/mvp/matches). Every other
  // HCCL season is an archive-only entry (see seasonSeeds) whose stats come
  // from the bundled season archive, not from tournament data roots.
  const LEGACY_META = {
    id: LEGACY_ID, name: "HCCL Season 06", short: "HCCL S6",
    logo: encodeURI("assets/HCCL Logos/S6 LOGO.jpg"),
    duration: "JUN 2026 - JUL 2026", status: "live", legacy: true,
    archive: "hccl", season: 6, order: 6, createdAt: 0,
  };
  // Names this entry may carry from earlier AUTO-writes (original seed, the
  // brief league-level rename). Migration only ever touches those - a manual
  // admin rename to anything else is final.
  const LEGACY_AUTO_NAMES = ["HC Champions League", "HCCL Season 06"];

  // Per-season HCCL entries: Season 01-05 (completed, honors + stats from the
  // bundled archive) and the scheduled next season. Derived from
  // window.HCCLSeasonArchive so the honors live in ONE place. Used both to
  // seed the cloud registry (once) and as the offline fallback list.
  const NEXT_SEASON = { no: 7, duration: "COMING SOON" };
  function seasonSeeds() {
    const A = window.HCCLSeasonArchive;
    const pad = n => String(n).padStart(2, "0");
    const seeds = (A ? A.seasons() : []).filter(s => !s.ongoing && s.champion).map(s => ({
      id: `hccl-s${s.no}`,
      name: `HCCL Season ${pad(s.no)}`, short: `HCCL S${s.no}`,
      logo: (A && A.seasonLogo(s.no)) || "",
      duration: s.year || "", status: "completed",
      archive: "hccl", season: s.no, order: s.no, createdAt: 0,
      honors: { champion: s.champion || "", runnerUp: s.runnerUp || "", mvp: s.mvp || "" },
    }));
    seeds.push({
      id: `hccl-s${NEXT_SEASON.no}`,
      name: `HCCL Season ${pad(NEXT_SEASON.no)}`, short: `HCCL S${NEXT_SEASON.no}`, logo: "",
      duration: NEXT_SEASON.duration, status: "upcoming",
      archive: "hccl", season: NEXT_SEASON.no, order: NEXT_SEASON.no, createdAt: 0,
      honors: null,
    });
    return seeds;
  }

  // Other HC tournaments (stats-sheet only: no auction/fantasy/MVP tabs - an
  // editor imports a Season-Stats-format CSV in each one's Details hub).
  // `order` slots them chronologically between the HCCL seasons (S4=4, S5=5,
  // S6=6). `solo: true` = players (not teams) contest the title, so the
  // champion/runner-up podium bubbles resolve player photos.
  const TOURNEY_SEEDS = [
    {
      id: "hc-mini-ipl-2026", name: "HC Mini IPL 2026", short: "MIPL 26",
      logo: encodeURI("assets/Tournament Logos/HC Mini IPL S1.png"),
      duration: "MAR 2026 - APR 2026", status: "completed",
      statsOnly: true, order: 4.5, createdAt: 0,
      honors: { champion: "Mumbai Indians", runnerUp: "Gujarat Titans", mvp: "Kalana Thenuja" },
    },
    {
      id: "solo-knockout-championship-s01", name: "Solo Knockout Championship S01", short: "SKC S1",
      logo: encodeURI("assets/Tournament Logos/Solo Knockout S1.png"),
      duration: "13 MAY 2026 - 14 MAY 2026", status: "completed",
      statsOnly: true, solo: true, order: 5.3, createdAt: 0,
      honors: { champion: "Chathuka Lakshan", runnerUp: "Nehan Fernando", mvp: "Chathuka Lakshan" },
    },
    {
      id: "hc-county-rising-league-s01", name: "HC County Rising League S01", short: "CRL S1",
      logo: encodeURI("assets/Tournament Logos/HC County Rising League S1.png"),
      duration: "MAY 2026 - JUN 2026", status: "completed",
      statsOnly: true, order: 5.5, createdAt: 0,
      honors: { champion: "Nova Rising Force", runnerUp: "Knights of Future", mvp: "Sandun Chinthana" },
    },
    {
      id: "hc-county-legends-league-s01", name: "HC County Legends League S01", short: "CLL S1", logo: "",
      duration: "MAY 2026 - JUN 2026", status: "completed",
      statsOnly: true, order: 5.6, createdAt: 0,
      honors: { champion: "Zyther Legends", runnerUp: "Legend Strikers", mvp: "Udara Perera" },
    },
  ];
  const allSeeds = () => [...seasonSeeds(), ...TOURNEY_SEEDS];

  const H = () => window.HCCL;
  const db = () => (window.HCCL ? window.HCCL.db : null);
  const fsa = () => (window.HCCL ? window.HCCL.fs : null);
  const cloudOn = () => { const h = H(); return !!(h && h.configured && h.user && db() && fsa()); };
  const editorOn = () => { const h = H(); return !h || !h.configured || h.canEdit(); };

  let ready = false;          // registry resolved (from cloud or fallback)
  let synced = false;         // registry snapshot attached
  let seeded = false;         // one-shot legacy seed attempted
  let tournaments = [LEGACY_META];
  let activeId = LEGACY_ID;
  let viewingId = null;
  let busy = false;           // a create/copy/delete is running
  const listeners = [];
  // form: null | { mode:"create" } | { mode:"edit", id }
  // detail: null | tournament id whose hub page is open (list ⇄ detail)
  const UI = { form: null, detail: null };

  /* ---------------- registry helpers ---------------- */
  const metaOf = id => tournaments.find(t => t.id === id) || null;

  // Tournaments whose detail hub shows the HCCL season archive: the legacy
  // entry (Season 06), plus the seeded per-season entries tagged archive:"hccl".
  const isHcclFamily = m => !!(m && (m.legacy || m.archive === "hccl"));
  // Archive-only entries have NO data roots (no auction/fixtures/fantasy) -
  // their Details hub is the whole content, so "viewing" them is meaningless.
  // Same for stats-sheet-only tournaments (Mini IPL, Solo Knockout, County
  // leagues): their record IS the imported stats sheet.
  const isArchiveOnly = m => !!(m && ((m.archive === "hccl" && !m.legacy) || m.statsOnly));

  function normMeta(id, d) {
    return {
      id, name: d.name || id, short: d.short || "", logo: d.logo || "",
      duration: d.duration || "", status: d.status || "completed",
      legacy: !!d.legacy, order: d.order == null ? 999 : d.order,
      createdAt: d.createdAt || 0,
      archive: d.archive || "",
      season: d.season || 0,
      statsOnly: !!d.statsOnly,
      solo: !!d.solo,
      // { champion, runnerUp, mvp, mostRuns?, mostWickets? } - drives this
      // tournament's card on the Home champions carousel once it's completed.
      honors: d.honors || null,
    };
  }

  function resolveViewing() {
    let want = null;
    try { want = localStorage.getItem(VIEW_KEY); } catch (e) {}
    // Never resolve to an archive-only entry - it has no data for the tabs.
    if (want) { const m = metaOf(want); if (m && !isArchiveOnly(m)) return want; }
    const act = metaOf(activeId);
    if (act && !isArchiveOnly(act)) return activeId;
    const firstReal = tournaments.find(t => !isArchiveOnly(t));
    return firstReal ? firstReal.id : LEGACY_ID;
  }

  function fire() {
    listeners.forEach(cb => { try { cb(api); } catch (e) { console.error(e); } });
  }

  /* ---------------- public API ---------------- */
  const api = {
    get ready() { return ready; },
    list: () => tournaments.slice(),
    viewingId: () => viewingId || LEGACY_ID,
    viewing: () => metaOf(viewingId) || LEGACY_META,
    activeId: () => activeId,
    isLegacy(id) {
      const m = metaOf(id == null ? (viewingId || LEGACY_ID) : id);
      return !m || !!m.legacy;
    },
    prefix() {
      return api.isLegacy(viewingId) ? [] : ["tournaments", viewingId];
    },
    setViewing(id) {
      if (!metaOf(id) || id === viewingId) return;
      if (isArchiveOnly(metaOf(id))) {
        toast("That season's record lives under its Details page", "bad");
        return;
      }
      if (!cloudOn() && !api.isLegacy(id)) {
        toast("Other tournaments live in the cloud - sign in to browse them", "bad");
        return;
      }
      viewingId = id;
      try { localStorage.setItem(VIEW_KEY, id); } catch (e) {}
      render(); renderBanner();
      fire();
      const m = metaOf(id);
      toast(`Now viewing ${m ? m.name : id}`, "good");
    },
    onChange(cb) {
      listeners.push(cb);
      if (ready) { try { cb(api); } catch (e) { console.error(e); } }
    },
  };
  window.HCCLSeries = api;

  /* ---------------- registry sync ---------------- */
  function fallbackReady() {
    // Offline mode still shows the full HC story: HCCL season entries, the
    // live legacy season, the scheduled next season, and the other seeded
    // tournaments (Mini IPL, Solo Knockout, County leagues).
    tournaments = [...allSeeds().filter(t => t.id !== LEGACY_ID), LEGACY_META]
      .sort((x, y) => (x.order - y.order) || (x.createdAt - y.createdAt));
    activeId = LEGACY_ID;
    viewingId = LEGACY_ID;
    if (!ready) { ready = true; render(); renderBanner(); fire(); }
  }

  function startRegistrySync() {
    if (synced || !cloudOn()) return;
    const a = fsa();
    if (!a.collection || !a.onSnapshot) { fallbackReady(); return; }
    synced = true;
    a.onSnapshot(a.collection(db(), "tournaments"), snap => {
      const metas = [];
      let cfg = null;
      snap.forEach(d => {
        if (d.id === "_config") cfg = d.data();
        else metas.push(normMeta(d.id, d.data()));
      });
      if (metas.length) {
        metas.sort((x, y) => (x.order - y.order) || (x.createdAt - y.createdAt));
        tournaments = metas;
        maybeMigrateLegacyMeta();    // one-time per-season restructure of the legacy entry
        maybeSeedSeasons(cfg);       // one-time seed of the bundled entries
        maybeNormalizeTournaments(); // adopt hand-created twins of the bundled tournaments
      } else {
        tournaments = [LEGACY_META];
        maybeSeed(); // first editor creates the registry
      }
      const cfgActive = cfg && cfg.activeId && metaOf(cfg.activeId);
      activeId = (cfgActive && !isArchiveOnly(metaOf(cfg.activeId))) ? cfg.activeId
        : (tournaments.find(t => !isArchiveOnly(t)) || tournaments[0] || LEGACY_META).id;
      if (!viewingId || !metaOf(viewingId)) viewingId = resolveViewing();
      ready = true;
      render(); renderBanner();
      fire(); // modules ignore it unless the viewed tournament actually changed
    }, err => {
      // Rules not published yet (permission-denied) or offline: single-tournament mode.
      console.warn("series registry unavailable:", err && err.code);
      fallbackReady();
    });
  }

  async function maybeSeed() {
    if (seeded || !cloudOn() || !editorOn()) return;
    seeded = true;
    const a = fsa();
    try {
      const meta = { ...LEGACY_META };
      delete meta.id;
      meta.createdAt = Date.now();
      await a.setDoc(a.doc(db(), "tournaments", LEGACY_ID), meta);
      await a.setDoc(a.doc(db(), "tournaments", "_config"), { activeId: LEGACY_ID });
    } catch (e) { console.warn("series seed failed:", e); }
  }

  // One-time restructure of the legacy entry: registries written by earlier
  // versions call it "HCCL Season 06" without season/archive fields, or
  // "HC Champions League" (the brief league-level rename). Both are auto-names,
  // so migrating them is safe; a manual admin rename is never touched.
  let legacyMigrateTried = false;
  async function maybeMigrateLegacyMeta() {
    if (legacyMigrateTried || !cloudOn() || !editorOn()) return;
    const m = metaOf(LEGACY_ID);
    if (!m || !LEGACY_AUTO_NAMES.includes(m.name)) return;
    const current = m.name === LEGACY_META.name && m.season === 6 && m.order === 6 && m.archive === "hccl";
    if (current) return;
    legacyMigrateTried = true;
    try {
      const target = {
        name: LEGACY_META.name, short: LEGACY_META.short, duration: LEGACY_META.duration,
        archive: "hccl", season: 6, order: 6,
      };
      if (!m.logo) target.logo = LEGACY_META.logo;
      await fsa().updateDoc(fsa().doc(db(), "tournaments", LEGACY_ID), target);
    } catch (e) { console.warn("legacy tournament migration failed:", e); legacyMigrateTried = false; }
  }

  // One-time seed of the bundled entries (HCCL seasons + the other HC
  // tournaments). Version-guarded via tournaments/_config.seasonSeedVersion so
  // an admin DELETING one of them stays deleted (no resurrect-on-reload loop).
  // v1 = HCCL S1-S5 + S7; v2 adds Mini IPL, Solo Knockout, County leagues.
  const SEASON_SEED_VERSION = "v2";
  let seasonSeedTried = false;
  async function maybeSeedSeasons(cfg) {
    if (seasonSeedTried || !cloudOn() || !editorOn()) return;
    if (cfg && cfg.seasonSeedVersion === SEASON_SEED_VERSION) return;
    seasonSeedTried = true;
    const a = fsa(), d = db();
    const norm = s => String(s || "").trim().toLowerCase();
    const byName = name => tournaments.find(t => norm(t.name) === norm(name));
    try {
      for (const seed of allSeeds()) {
        // Never overwrite - and never DUPLICATE a tournament an admin already
        // created by hand under a different id but the same name.
        if (metaOf(seed.id) || byName(seed.name)) continue;
        const meta = { ...seed, createdAt: Date.now() };
        delete meta.id;
        if (!meta.honors) delete meta.honors;
        await a.setDoc(a.doc(d, "tournaments", seed.id), meta);
      }
      await a.setDoc(a.doc(d, "tournaments", "_config"),
        { activeId: activeId || LEGACY_ID, seasonSeedVersion: SEASON_SEED_VERSION });
    } catch (e) { console.warn("tournament seed failed:", e); seasonSeedTried = false; }
  }

  // Adopt tournaments an admin created by hand through the ＋ New Tournament
  // form: the form doesn't know about identity flags, so a doc matching one
  // of our bundled tournaments (by id or name) gets its missing pieces filled
  // in - flags, chronological order, logo, honors. Existing values an admin
  // typed are never overwritten.
  let normalizeTried = false;
  async function maybeNormalizeTournaments() {
    if (normalizeTried || !cloudOn() || !editorOn()) return;
    const a = fsa(), d = db();
    if (!a.updateDoc) return;
    const norm = s => String(s || "").trim().toLowerCase();
    const patches = [];
    for (const seed of TOURNEY_SEEDS) {
      const m = metaOf(seed.id) || tournaments.find(t => norm(t.name) === norm(seed.name));
      if (!m) continue;
      const patch = {};
      if (!m.statsOnly) patch.statsOnly = true;
      if (seed.solo && !m.solo) patch.solo = true;
      if (m.order !== seed.order) patch.order = seed.order;
      if (!m.logo && seed.logo) patch.logo = seed.logo;
      if (!m.duration && seed.duration) patch.duration = seed.duration;
      // A completed tournament left on the form's default "upcoming" never
      // reaches the carousel - lift it to the seed's status.
      if (m.status === "upcoming" && seed.status === "completed") patch.status = "completed";
      if (seed.honors && !(m.honors && m.honors.champion)) patch.honors = seed.honors;
      if (Object.keys(patch).length) patches.push({ id: m.id, patch });
    }
    if (!patches.length) return;
    normalizeTried = true;
    try {
      for (const p of patches) await a.updateDoc(a.doc(d, "tournaments", p.id), p.patch);
    } catch (e) { console.warn("tournament normalize failed:", e); normalizeTried = false; }
  }

  /* ---------------- admin: create / edit / copy / delete ---------------- */
  function slugify(name) {
    let s = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (!s) s = "tournament";
    if (s === "_config") s = "tournament-config";
    let id = s, n = 2;
    while (metaOf(id)) { id = `${s}-${n++}`; }
    return id;
  }

  // Copy teams & players (incl. logos/photos + settings) from one tournament's
  // auction into a NEW tournament. Players are reset to "available" (fresh
  // auction); purse spend is derived from sold players, so teams copy as-is.
  async function copyAuctionData(srcId, dstId, dstName) {
    const a = fsa(), d = db();
    const src = api.isLegacy(srcId) ? [] : ["tournaments", srcId];
    const dst = ["tournaments", dstId];
    let copied = 0;
    for (const coll of ["teams", "players", "teamLogos", "playerPhotos"]) {
      const snap = await a.getDocs(a.collection(d, ...src, "auction", "league", coll));
      for (const docSnap of snap.docs) {
        let data = docSnap.data();
        if (coll === "players") {
          data = { ...data, status: "available", soldTo: null, soldPrice: null, retained: false };
          delete data.soldBids;
        }
        await a.setDoc(a.doc(d, ...dst, "auction", "league", coll, docSnap.id), data);
        copied++;
      }
    }
    const st = await a.getDoc(a.doc(d, ...src, "auction", "league", "state", "settings"));
    const s = st.exists() ? st.data() : {};
    await a.setDoc(a.doc(d, ...dst, "auction", "league", "state", "settings"),
      { ...s, seasonName: dstName });
    return copied;
  }

  // A tournament may only be deleted while its data roots are empty
  // (deleting the meta doc would NOT delete subcollections - they'd orphan).
  async function tournamentIsEmpty(tid) {
    const a = fsa(), d = db();
    const roots = [
      ["tournaments", tid, "auction", "league", "teams"],
      ["tournaments", tid, "auction", "league", "players"],
      ["tournaments", tid, "matches"],
      ["tournaments", tid, "mvp"],
      ["tournaments", tid, "fantasy", "league", "teams"],
    ];
    for (const segs of roots) {
      const snap = await a.getDocs(a.collection(d, ...segs));
      if (!snap.empty) return false;
    }
    return true;
  }

  async function submitForm() {
    if (busy) return;
    if (!editorOn() || !cloudOn()) { toast("You don't have permission to manage tournaments", "bad"); return; }
    const name = ($("#serName").value || "").trim();
    if (!name) { toast("Give the tournament a name", "bad"); return; }
    const short = ($("#serShort").value || "").trim();
    const duration = ($("#serDuration").value || "").trim();
    const status = $("#serStatus").value || "upcoming";
    const file = $("#serLogoFile").files[0];
    const a = fsa(), d = db();
    busy = true; render();
    try {
      let logo = "";
      if (file) { try { logo = await fileToDataURL(file, 220, "png"); } catch (e) { toast("Couldn't read the logo image", "bad"); } }

      // Honors (all optional). Leaving every field blank clears them - the
      // setDoc below replaces the whole meta doc, so an omitted key is removed.
      const champion = ($("#serChampion").value || "").trim();
      const runnerUp = ($("#serRunnerUp").value || "").trim();
      const mvp = ($("#serMvp").value || "").trim();
      const mostRuns = ($("#serMostRuns").value || "").trim();
      const mostWickets = ($("#serMostWickets").value || "").trim();
      const honors = (champion || runnerUp || mvp || mostRuns || mostWickets)
        ? { champion, runnerUp, mvp, mostRuns, mostWickets } : null;

      if (UI.form && UI.form.mode === "edit") {
        const cur = metaOf(UI.form.id);
        if (!cur) throw new Error("tournament vanished");
        await a.setDoc(a.doc(d, "tournaments", cur.id), {
          name, short, duration, status,
          logo: logo || cur.logo || "",
          legacy: !!cur.legacy, order: cur.order, createdAt: cur.createdAt || Date.now(),
          // setDoc replaces the whole doc - carry the identity flags over.
          ...(cur.archive ? { archive: cur.archive } : {}),
          ...(cur.season ? { season: cur.season } : {}),
          ...(cur.statsOnly ? { statsOnly: true } : {}),
          ...(cur.solo ? { solo: true } : {}),
          ...(honors ? { honors } : {}),
        });
        toast("Tournament updated", "good");
      } else {
        const id = slugify(name);
        const srcId = $("#serCopyFrom") ? $("#serCopyFrom").value : "";
        await a.setDoc(a.doc(d, "tournaments", id), {
          name, short, duration, status, logo,
          order: tournaments.length, createdAt: Date.now(),
          ...(honors ? { honors } : {}),
        });
        if (srcId) {
          toast("Copying teams & players…");
          const n = await copyAuctionData(srcId, id, name);
          toast(`Tournament created - copied ${n} docs from ${(metaOf(srcId) || {}).name || srcId}`, "good");
        } else {
          toast("Tournament created", "good");
        }
      }
      UI.form = null;
    } catch (e) {
      console.error(e);
      toast("Couldn't save the tournament", "bad");
    }
    busy = false; render();
  }

  async function removeTournament(id) {
    if (busy) return;
    if (!editorOn() || !cloudOn()) return;
    const m = metaOf(id);
    if (!m || m.legacy) return;
    if (id === activeId) { toast("Can't delete the active tournament - set another as default first", "bad"); return; }
    if (!confirm(`Delete tournament "${m.name}"?\n\nOnly possible while it has no data.`)) return;
    busy = true; render();
    try {
      if (!(await tournamentIsEmpty(id))) {
        toast(`"${m.name}" has data (auction/fixtures/MVP/fantasy) - it can't be deleted`, "bad");
      } else {
        await fsa().deleteDoc(fsa().doc(db(), "tournaments", id));
        if (viewingId === id) api.setViewing(activeId);
        toast("Tournament deleted", "good");
      }
    } catch (e) { console.error(e); toast("Couldn't delete the tournament", "bad"); }
    busy = false; render();
  }

  async function setDefault(id) {
    if (busy || !metaOf(id)) return;
    if (!editorOn() || !cloudOn()) return;
    try {
      await fsa().setDoc(fsa().doc(db(), "tournaments", "_config"), { activeId: id });
      toast(`${metaOf(id).name} is now the default tournament`, "good");
    } catch (e) { console.error(e); toast("Couldn't set the default tournament", "bad"); }
  }

  /* ---------------- Series page ---------------- */
  const STATUS_LABEL = { live: "● LIVE", completed: "COMPLETED", upcoming: "UPCOMING" };

  function logoHtml(m) {
    const A = window.HCCLSeasonArchive;
    // Meta logo (admin-uploaded dataURL or seeded asset path) wins; else the
    // committed tournament badge matched by name; else initials.
    const logo = m.logo || (A && A.tournamentLogo && A.tournamentLogo(m.name)) || "";
    const style = logo ? ` style="background-image:url('${logo}')"` : "";
    const text = logo ? "" : esc((m.short || m.name || "?").trim().slice(0, 3).toUpperCase());
    return `<div class="series-logo"${style}>${text}</div>`;
  }

  function cardHtml(m) {
    const isViewing = m.id === (viewingId || LEGACY_ID);
    const archiveOnly = isArchiveOnly(m);
    const chips = [
      `<span class="series-chip st-${esc(m.status)}">${STATUS_LABEL[m.status] || esc(m.status)}</span>`,
      m.id === activeId ? `<span class="series-chip st-default">DEFAULT</span>` : "",
      isViewing ? `<span class="series-chip st-viewing">VIEWING</span>` : "",
    ].join("");
    const admin = (editorOn() && cloudOn()) ? `
      <div class="series-admin-row">
        <button class="icon-btn" data-series-edit="${esc(m.id)}" title="Edit tournament">✎</button>
        ${(!archiveOnly && m.id !== activeId) ? `<button class="icon-btn" data-series-default="${esc(m.id)}" title="Make this the default tournament">★</button>` : ""}
        ${(!m.legacy && m.id !== activeId) ? `<button class="icon-btn del" data-series-del="${esc(m.id)}" title="Delete (only while empty)">🗑</button>` : ""}
      </div>` : "";
    // Archive-only seasons have no auction/fixtures data to "View" - their
    // Details hub IS the content.
    const viewBtn = archiveOnly ? "" : (isViewing
      ? `<button class="btn btn-dark" disabled>✓ Viewing</button>`
      : `<button class="btn btn-yellow" data-series-view="${esc(m.id)}">View</button>`);
    return `
      <div class="series-card${isViewing ? " viewing" : ""}" data-series-open="${esc(m.id)}">
        ${logoHtml(m)}
        <div class="series-meta">
          <h3>${esc(m.name)}</h3>
          ${m.duration ? `<div class="series-dur">${esc(m.duration)}</div>` : ""}
          <div class="series-chips">${chips}</div>
        </div>
        <div class="series-actions">
          ${viewBtn}
          <button class="btn btn-dark" data-series-open="${esc(m.id)}">Details ›</button>
          ${admin}
        </div>
      </div>`;
  }

  function formHtml() {
    const editing = UI.form && UI.form.mode === "edit" ? metaOf(UI.form.id) : null;
    const copyOptions = tournaments
      .map(t => `<option value="${esc(t.id)}">Copy teams &amp; players of ${esc(t.name)}</option>`).join("");
    return `
      <div class="card series-form">
        <h3>${editing ? `Edit ${esc(editing.name)}` : "New Tournament"}</h3>
        <label>Tournament name
          <input type="text" id="serName" placeholder="e.g. Mini IPL" value="${editing ? esc(editing.name) : ""}" />
        </label>
        <label>Short name (for small badges)
          <input type="text" id="serShort" placeholder="e.g. MIPL" value="${editing ? esc(editing.short) : ""}" />
        </label>
        <label>Duration
          <input type="text" id="serDuration" placeholder="e.g. AUG 2026 - SEP 2026" value="${editing ? esc(editing.duration) : ""}" />
        </label>
        <label>Status
          <select id="serStatus">
            ${["upcoming", "live", "completed"].map(s =>
              `<option value="${s}"${editing && editing.status === s ? " selected" : ""}>${s[0].toUpperCase()}${s.slice(1)}</option>`).join("")}
          </select>
        </label>
        <label>Tournament logo${editing && editing.logo ? " (leave empty to keep current)" : ""}
          <input type="file" id="serLogoFile" accept="image/*" />
        </label>
        <details class="stats-fieldset"${editing && editing.honors ? " open" : ""}>
          <summary>Honors (optional) - shown on the Home champions carousel once completed</summary>
          <label>Champion (team, or player for solo events)
            <input type="text" id="serChampion" placeholder="e.g. Super Fire Dragons" value="${editing && editing.honors ? esc(editing.honors.champion || "") : ""}" />
          </label>
          <label>Runner-up
            <input type="text" id="serRunnerUp" placeholder="e.g. Matrix" value="${editing && editing.honors ? esc(editing.honors.runnerUp || "") : ""}" />
          </label>
          <label>MVP (player)
            <input type="text" id="serMvp" placeholder="e.g. Sasindu Madushan" value="${editing && editing.honors ? esc(editing.honors.mvp || "") : ""}" />
          </label>
          <label>Most Runs (player)
            <input type="text" id="serMostRuns" placeholder="auto-filled by a stats-sheet import" value="${editing && editing.honors ? esc(editing.honors.mostRuns || "") : ""}" />
          </label>
          <label>Most Wickets (player)
            <input type="text" id="serMostWickets" placeholder="auto-filled by a stats-sheet import" value="${editing && editing.honors ? esc(editing.honors.mostWickets || "") : ""}" />
          </label>
        </details>
        ${editing ? "" : `
        <label>Start from
          <select id="serCopyFrom">
            <option value="">Blank (add teams &amp; players in Setup)</option>
            ${copyOptions}
          </select>
        </label>`}
        <div class="form-row">
          <button class="btn btn-red" data-series-save ${busy ? "disabled" : ""}>${busy ? "Working…" : (editing ? "Save Changes" : "Create Tournament")}</button>
          <button class="btn btn-dark" data-series-cancel ${busy ? "disabled" : ""}>Cancel</button>
        </div>
        ${editing ? "" : `<p class="hint">The new tournament gets its own auction, squads, fixtures &amp; results, MVP and fantasy - nothing here touches other tournaments.</p>`}
      </div>`;
  }

  /* ---- per-tournament stats sheet (non-HCCL tournaments) ---- */
  // The imported sheet lives at tournaments/{tid}/stats/sheet = { csv,
  // playerCount, updatedAt, updatedBy } - already covered by the recursive
  // tournaments/** security rule, so no rules change is needed. While a hub
  // is open we follow the doc with onSnapshot, so an editor's import shows
  // up on every device immediately.
  let statsTid = null, statsUnsub = null, statsCsv = null, statsLoaded = false;
  let detailBoard = "overall"; // board sub-tab inside a stats hub

  function startDetailStats(tid) {
    if (statsTid === tid) return;
    stopDetailStats();
    statsTid = tid;
    detailBoard = "overall";
    const a = fsa();
    if (!cloudOn() || !a.onSnapshot) { statsLoaded = true; return; }
    statsUnsub = a.onSnapshot(a.doc(db(), "tournaments", tid, "stats", "sheet"), snap => {
      const data = snap.exists() ? snap.data() : null;
      statsCsv = (data && typeof data.csv === "string" && data.csv.trim()) ? data.csv : null;
      statsLoaded = true;
      if (UI.detail === tid) render();
    }, err => {
      console.warn("tournament stats snapshot error:", err && err.code);
      statsLoaded = true;
      if (UI.detail === tid) render();
    });
  }

  function stopDetailStats() {
    if (statsUnsub) { statsUnsub(); statsUnsub = null; }
    statsTid = null; statsCsv = null; statsLoaded = false;
  }

  // The sheet a hub renders from: a cloud-imported one wins, else the bundled
  // copy shipped with the site (js/tournament-stats-data.js), else nothing.
  function effectiveCsv(m) {
    const A = window.HCCLSeasonArchive;
    return statsCsv || (A && A.tournamentCsv(m.id, m.name)) || null;
  }

  // Podium (Champion / Runner-up / MVP) + Most Runs / Most Wickets at the top
  // of a stats-only tournament hub. Leaders derive from the stats sheet when
  // one exists, falling back to hand-entered honors fields.
  function hubHonorsHtml(m) {
    const A = window.HCCLSeasonArchive;
    if (!A) return "";
    const h = m.honors || {};
    const hasPodium = !!(h.champion || h.runnerUp || h.mvp);
    let lead = { mostRuns: h.mostRuns || "", mostWickets: h.mostWickets || "" };
    const csv = effectiveCsv(m);
    if (csv) {
      const der = A.leadersFromRows(A.rowsFromCsv(csv));
      lead = { mostRuns: der.mostRuns || lead.mostRuns, mostWickets: der.mostWickets || lead.mostWickets };
    }
    const hasLead = !!(lead.mostRuns || lead.mostWickets);
    if (!hasPodium && !hasLead) return "";
    return `
      <div class="card series-honors">
        <div class="hub-honors">
          ${hasPodium ? A.podiumHtml(h, m.solo ? "player" : "team") : ""}
          ${hasLead ? `<div class="hub-leads">
            ${A.extraItem("🏏", "Most Runs", lead.mostRuns || "TBD")}
            ${A.extraItem("🎯", "Most Wickets", lead.mostWickets || "TBD")}
          </div>` : ""}
        </div>
      </div>`;
  }

  function statsPanelHtml(m) {
    const A = window.HCCLSeasonArchive;
    const admin = editorOn();
    const importBtn = admin ? `
      <label class="btn btn-yellow file-btn tstats-import" title="Upload this tournament's stats CSV (36-column Season Stats format; raw STUMPS exports are fine)">
        <span>⬆ Import Stats Sheet</span>
        <input type="file" class="tstats-import-file" accept=".csv,text/csv" hidden />
      </label>` : "";
    const csv = effectiveCsv(m);
    let body;
    if (!csv) {
      body = !statsLoaded && cloudOn()
        ? `<p class="hint">Loading stats…</p>`
        : `<p class="hint">${admin
            ? "No stats sheet imported yet - upload this tournament's Season-Stats CSV to publish its leaderboards for everyone."
            : "Stats for this tournament haven't been published yet - check back soon."}</p>`;
    } else {
      const rows = A.rowsFromCsv(csv);
      body = `
        <div class="board-tabs" role="tablist">
          ${A.boardKeys().map(b => `<button class="board-tab${b.key === detailBoard ? " active" : ""}" data-tstat-board="${b.key}">${esc(b.label)}</button>`).join("")}
        </div>
        <div class="board-panel tstats-panel">${A.boardHtml(rows, detailBoard)}</div>`;
    }
    return `
      <div class="card series-stats">
        <div class="season-boards-head">
          <h3 class="season-boards-title">${esc(m.short || m.name)} · Player Stats</h3>
          ${importBtn}
        </div>
        ${body}
      </div>`;
  }

  // Editor-only: publish an uploaded stats CSV for this tournament, and lift
  // its Most Runs / Most Wickets into the meta honors so the Home carousel
  // shows them without ever reading the sheet itself.
  async function importTournamentStats(file, tid) {
    if (!file || !tid) return;
    const A = window.HCCLSeasonArchive;
    if (!A) return;
    if (!editorOn()) { toast("Only moderators/admins can import stats", "bad"); return; }
    let text = "";
    try { text = await file.text(); } catch (e) { toast("Couldn't read that file", "bad"); return; }
    text = A.normalizeSheet(text); // tolerate raw STUMPS exports (preamble rows)
    const check = A.validateCsv(text);
    if (!check.ok) { toast(check.reason, "bad"); return; }
    const leaders = A.leadersFromRows(A.rowsFromCsv(text));
    if (cloudOn()) {
      try {
        const a = fsa(), d = db();
        const h = H();
        await a.setDoc(a.doc(d, "tournaments", tid, "stats", "sheet"), {
          csv: text, playerCount: check.playerCount,
          updatedAt: a.serverTimestamp ? a.serverTimestamp() : Date.now(),
          updatedBy: (h && h.user && (h.user.displayName || h.user.email)) || "",
        });
        const upd = {};
        if (leaders.mostRuns) upd["honors.mostRuns"] = leaders.mostRuns;
        if (leaders.mostWickets) upd["honors.mostWickets"] = leaders.mostWickets;
        if (Object.keys(upd).length && a.updateDoc) {
          await a.updateDoc(a.doc(d, "tournaments", tid), upd)
            .catch(e => console.warn("carousel leader update failed:", e));
        }
        toast(`Stats imported - ${check.playerCount} players. Live for everyone.`, "good");
        // onSnapshot re-renders every device (including this one).
      } catch (e) {
        console.error("tournament stats import failed:", e);
        toast("Upload failed - need moderator/admin + published rules", "bad");
      }
      return;
    }
    // Offline / open mode: apply on this device only.
    if (statsTid === tid) { statsCsv = text; statsLoaded = true; render(); }
    toast(`Stats imported - ${check.playerCount} players (this device only)`, "good");
  }

  /* -------- tournament detail hub (list ⇄ detail inside #view-series) -------- */
  function detailBodyHtml(m) {
    // HCCL-family tournaments show THAT season's record (playoffs bracket,
    // top run-scorer/wicket-taker, leaderboards) - mounted after innerHTML
    // below. The live season also gets shortcuts to its live data tabs,
    // which earlier seasons never had (no MVP/fantasy back then).
    if (isHcclFamily(m)) {
      const links = m.legacy ? `
      <div class="card series-quick">
        <h3>Live season data</h3>
        <p class="hint">Auction squads, fixtures &amp; results, MVP rankings and fantasy for this season run live in their own tabs.</p>
        <div class="form-row">
          <button class="btn btn-dark" data-goto="fixtures">📅 Fixtures &amp; Results</button>
          <button class="btn btn-dark" data-goto="mvp">🏅 MVP Rankings</button>
          <button class="btn btn-dark" data-goto="fantasy">🏏 Fantasy</button>
          <button class="btn btn-dark" data-goto="auctions">🔨 Auction</button>
        </div>
      </div>` : "";
      return `${links}<div class="series-archive"></div>`;
    }
    // Everything else: podium + leaders up top, the stats sheet below.
    return hubHonorsHtml(m) + statsPanelHtml(m);
  }

  function renderDetail(view, m) {
    const admin = editorOn() && cloudOn();
    const isViewing = m.id === (viewingId || LEGACY_ID);
    // Follow this tournament's stats sheet while its hub is open (no-op for
    // HCCL-family hubs, which render from the bundled archive instead).
    if (isHcclFamily(m)) stopDetailStats(); else startDetailStats(m.id);
    const chips = [
      `<span class="series-chip st-${esc(m.status)}">${STATUS_LABEL[m.status] || esc(m.status)}</span>`,
      m.id === activeId ? `<span class="series-chip st-default">DEFAULT</span>` : "",
      isViewing ? `<span class="series-chip st-viewing">VIEWING</span>` : "",
    ].join("");
    view.innerHTML = `
      <div class="view-head series-detail-head">
        <button class="btn btn-dark series-back" data-series-back>‹ All Series</button>
        <h2>${esc(m.short || m.name).toUpperCase()}</h2>
      </div>
      <div class="series-card series-detail-card${isViewing ? " viewing" : ""}">
        ${logoHtml(m)}
        <div class="series-meta">
          <h3>${esc(m.name)}</h3>
          ${m.duration ? `<div class="series-dur">${esc(m.duration)}</div>` : ""}
          <div class="series-chips">${chips}</div>
        </div>
        <div class="series-actions">
          ${isArchiveOnly(m) ? "" : (isViewing
            ? `<button class="btn btn-dark" disabled>✓ Viewing</button>`
            : `<button class="btn btn-yellow" data-series-view="${esc(m.id)}">View</button>`)}
          ${admin ? `
          <div class="series-admin-row">
            <button class="icon-btn" data-series-edit="${esc(m.id)}" title="Edit tournament">✎</button>
            ${(!isArchiveOnly(m) && m.id !== activeId) ? `<button class="icon-btn" data-series-default="${esc(m.id)}" title="Make this the default tournament">★</button>` : ""}
          </div>` : ""}
        </div>
      </div>
      ${UI.form ? formHtml() : ""}
      ${detailBodyHtml(m)}`;
    const holder = view.querySelector(".series-archive");
    if (holder && window.HCCLSeasonArchive) {
      // Every HCCL-family entry carries its season number; pin the mount to it
      // so the hub shows just that season (no season-tab row).
      const sn = m.season || (m.legacy ? 6 : null);
      window.HCCLSeasonArchive.mount(holder, sn == null ? undefined : sn);
    } else if (window.HCCLSeasonArchive) {
      window.HCCLSeasonArchive.unmount();
    }
  }

  function render() {
    const view = document.getElementById("view-series");
    if (!view) return;
    // Detail mode - unless the tournament vanished from the registry.
    if (UI.detail && !metaOf(UI.detail)) UI.detail = null;
    if (UI.detail) { renderDetail(view, metaOf(UI.detail)); return; }
    if (window.HCCLSeasonArchive) window.HCCLSeasonArchive.unmount();
    stopDetailStats();
    const admin = editorOn() && cloudOn();
    const offlineHint = !cloudOn()
      ? `<p class="hint series-hint">Multi-tournament browsing works through the shared cloud - sign in to see and switch tournaments.</p>` : "";
    view.innerHTML = `
      <div class="view-head">
        <h2>SERIES &amp; TOURNAMENTS</h2>
        ${admin ? `<div class="view-head-tools"><button class="btn btn-yellow" data-series-new>＋ New Tournament</button></div>` : ""}
      </div>
      ${offlineHint}
      <div class="series-grid">
        ${tournaments.map(cardHtml).join("")}
      </div>
      ${UI.form ? formHtml() : ""}`;
  }

  /* ------- banner shown app-wide while viewing a non-default tournament ------- */
  function renderBanner() {
    let bar = document.getElementById("seriesBanner");
    const show = ready && viewingId && activeId && viewingId !== activeId;
    if (!show) { if (bar) bar.remove(); return; }
    const v = metaOf(viewingId) || LEGACY_META;
    const act = metaOf(activeId);
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "seriesBanner";
      bar.className = "series-banner";
      const header = document.querySelector(".app-header");
      if (header) header.insertAdjacentElement("afterend", bar);
      else document.body.prepend(bar);
    }
    bar.innerHTML = `
      <span>👁 Viewing <b>${esc(v.name)}</b>${act ? ` - the current tournament is <b>${esc(act.name)}</b>` : ""}</span>
      ${act ? `<button class="btn btn-yellow" data-series-view="${esc(act.id)}">↩ Back to ${esc(act.short || act.name)}</button>` : ""}`;
  }

  /* ---------------- events ---------------- */
  function onClick(e) {
    const t = e.target;
    const view = t.closest("[data-series-view]");
    if (view) { api.setViewing(view.getAttribute("data-series-view")); return; }
    if (t.closest("[data-series-new]")) { UI.form = { mode: "create" }; render(); return; }
    const edit = t.closest("[data-series-edit]");
    if (edit) { UI.form = { mode: "edit", id: edit.getAttribute("data-series-edit") }; render(); return; }
    const del = t.closest("[data-series-del]");
    if (del) { removeTournament(del.getAttribute("data-series-del")); return; }
    const dflt = t.closest("[data-series-default]");
    if (dflt) { setDefault(dflt.getAttribute("data-series-default")); return; }
    if (t.closest("[data-series-save]")) { submitForm(); return; }
    if (t.closest("[data-series-cancel]")) { UI.form = null; render(); return; }
    if (t.closest("[data-series-back]")) { UI.detail = null; UI.form = null; render(); return; }
    // Stats-hub board sub-tab: swap only the board panel (no page jump).
    const tb = t.closest("[data-tstat-board]");
    if (tb) {
      const key = tb.getAttribute("data-tstat-board");
      if (key && key !== detailBoard) {
        detailBoard = key;
        const A = window.HCCLSeasonArchive;
        const panel = document.querySelector(".tstats-panel");
        const m = UI.detail ? metaOf(UI.detail) : null;
        const csv = m ? effectiveCsv(m) : null; // cloud sheet or the bundled copy
        if (panel && A && csv) panel.innerHTML = A.boardHtml(A.rowsFromCsv(csv), detailBoard);
        document.querySelectorAll("[data-tstat-board]").forEach(b =>
          b.classList.toggle("active", b.getAttribute("data-tstat-board") === detailBoard));
      }
      return;
    }
    // Checked LAST: the whole list card is clickable, but its buttons
    // (View / edit / delete / default) must win over "open the hub".
    const open = t.closest("[data-series-open]");
    if (open) {
      const id = open.getAttribute("data-series-open");
      if (metaOf(id)) { UI.detail = id; UI.form = null; render(); }
      return;
    }
  }

  /* ---------------- init ---------------- */
  function onAuth() {
    const h = H();
    if (h && h.configured && h.user) startRegistrySync();
    else if (!h || !h.configured) fallbackReady(); // offline mode: single tournament
    render(); renderBanner();
  }

  function init() {
    // Delegated: covers the Series page AND the banner (outside the page).
    document.addEventListener("click", onClick);
    // Stats-sheet import inside a tournament hub (editor-only button).
    document.addEventListener("change", e => {
      const inp = e.target.closest(".tstats-import-file");
      if (inp && inp.files && inp.files[0] && UI.detail) {
        importTournamentStats(inp.files[0], UI.detail);
        inp.value = "";
      }
    });
    const tabs = document.getElementById("tabs");
    if (tabs) tabs.addEventListener("click", e => { if (e.target.closest('[data-tab="series"]')) render(); });
    if (window.HCCL && typeof window.HCCL.onChange === "function") window.HCCL.onChange(onAuth);
    onAuth();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
