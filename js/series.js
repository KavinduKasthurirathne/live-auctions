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
  // The legacy entry represents the WHOLE HC Champions League (its data roots
  // hold the ongoing season; the S1-S6 archive renders inside its detail hub).
  const LEGACY_META = {
    id: LEGACY_ID, name: "HC Champions League", short: "HCCL", logo: "",
    duration: "NOV 2025 - PRESENT", status: "live", legacy: true, order: 0, createdAt: 0,
  };
  // The stored name this entry had before the rebrand - used to migrate the
  // cloud doc exactly once without ever clobbering a later admin rename.
  const LEGACY_OLD_NAME = "HCCL Season 06";

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
  // entry (it IS the league), plus anything explicitly tagged archive:"hccl".
  const isHcclFamily = m => !!(m && (m.legacy || m.archive === "hccl"));

  function normMeta(id, d) {
    return {
      id, name: d.name || id, short: d.short || "", logo: d.logo || "",
      duration: d.duration || "", status: d.status || "completed",
      legacy: !!d.legacy, order: d.order == null ? 999 : d.order,
      createdAt: d.createdAt || 0,
      archive: d.archive || "",
      // { champion, runnerUp, mvp } - drives this tournament's card on the
      // Home champions carousel (and its detail hub) once it's completed.
      honors: d.honors || null,
    };
  }

  function resolveViewing() {
    let want = null;
    try { want = localStorage.getItem(VIEW_KEY); } catch (e) {}
    if (want && metaOf(want)) return want;
    if (metaOf(activeId)) return activeId;
    return tournaments.length ? tournaments[0].id : LEGACY_ID;
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
    tournaments = [LEGACY_META]; activeId = LEGACY_ID;
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
        maybeMigrateLegacyName(); // one-time rebrand of the seeded legacy entry
      } else {
        tournaments = [LEGACY_META];
        maybeSeed(); // first editor creates the registry
      }
      activeId = (cfg && cfg.activeId && metaOf(cfg.activeId)) ? cfg.activeId
        : (tournaments[0] ? tournaments[0].id : LEGACY_ID);
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

  // Registries seeded before the HC Leagues rebrand still say "HCCL Season 06".
  // The first editor to load the page renames the entry to the league-level
  // identity - guarded on the OLD name so a deliberate admin rename is final.
  let renameTried = false;
  async function maybeMigrateLegacyName() {
    if (renameTried || !cloudOn() || !editorOn()) return;
    const m = metaOf(LEGACY_ID);
    if (!m || m.name !== LEGACY_OLD_NAME) return;
    renameTried = true;
    try {
      await fsa().updateDoc(fsa().doc(db(), "tournaments", LEGACY_ID), {
        name: LEGACY_META.name, short: LEGACY_META.short, duration: LEGACY_META.duration,
      });
    } catch (e) { console.warn("legacy tournament rename failed:", e); renameTried = false; }
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
      const honors = (champion || runnerUp || mvp) ? { champion, runnerUp, mvp } : null;

      if (UI.form && UI.form.mode === "edit") {
        const cur = metaOf(UI.form.id);
        if (!cur) throw new Error("tournament vanished");
        await a.setDoc(a.doc(d, "tournaments", cur.id), {
          name, short, duration, status,
          logo: logo || cur.logo || "",
          legacy: !!cur.legacy, order: cur.order, createdAt: cur.createdAt || Date.now(),
          ...(cur.archive ? { archive: cur.archive } : {}),
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
    const style = m.logo ? ` style="background-image:url('${m.logo}')"` : "";
    const text = m.logo ? "" : esc((m.short || m.name || "?").trim().slice(0, 3).toUpperCase());
    return `<div class="series-logo"${style}>${text}</div>`;
  }

  function cardHtml(m) {
    const isViewing = m.id === (viewingId || LEGACY_ID);
    const chips = [
      `<span class="series-chip st-${esc(m.status)}">${STATUS_LABEL[m.status] || esc(m.status)}</span>`,
      m.id === activeId ? `<span class="series-chip st-default">DEFAULT</span>` : "",
      isViewing ? `<span class="series-chip st-viewing">VIEWING</span>` : "",
    ].join("");
    const admin = (editorOn() && cloudOn()) ? `
      <div class="series-admin-row">
        <button class="icon-btn" data-series-edit="${esc(m.id)}" title="Edit tournament">✎</button>
        ${m.id !== activeId ? `<button class="icon-btn" data-series-default="${esc(m.id)}" title="Make this the default tournament">★</button>` : ""}
        ${(!m.legacy && m.id !== activeId) ? `<button class="icon-btn del" data-series-del="${esc(m.id)}" title="Delete (only while empty)">🗑</button>` : ""}
      </div>` : "";
    return `
      <div class="series-card${isViewing ? " viewing" : ""}" data-series-open="${esc(m.id)}">
        ${logoHtml(m)}
        <div class="series-meta">
          <h3>${esc(m.name)}</h3>
          ${m.duration ? `<div class="series-dur">${esc(m.duration)}</div>` : ""}
          <div class="series-chips">${chips}</div>
        </div>
        <div class="series-actions">
          ${isViewing
            ? `<button class="btn btn-dark" disabled>✓ Viewing</button>`
            : `<button class="btn btn-yellow" data-series-view="${esc(m.id)}">View</button>`}
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
          <label>Champion (team)
            <input type="text" id="serChampion" placeholder="e.g. Super Fire Dragons" value="${editing && editing.honors ? esc(editing.honors.champion || "") : ""}" />
          </label>
          <label>Runner-up (team)
            <input type="text" id="serRunnerUp" placeholder="e.g. Matrix" value="${editing && editing.honors ? esc(editing.honors.runnerUp || "") : ""}" />
          </label>
          <label>MVP (player)
            <input type="text" id="serMvp" placeholder="e.g. Sasindu Madushan" value="${editing && editing.honors ? esc(editing.honors.mvp || "") : ""}" />
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

  /* -------- tournament detail hub (list ⇄ detail inside #view-series) -------- */
  function detailBodyHtml(m) {
    // HCCL-family tournaments carry the full season archive (season tabs,
    // podium, playoffs bracket, leaderboards) - mounted after innerHTML below.
    if (isHcclFamily(m)) return `<div class="series-archive"></div>`;
    const A = window.HCCLSeasonArchive;
    const h = m.honors || {};
    const hasHonors = !!(h.champion || h.runnerUp || h.mvp);
    return `
      <div class="card series-honors">
        <h3>Honors</h3>
        ${hasHonors && A ? A.podiumHtml(h) : `<p class="hint">${m.status === "completed"
          ? "Honors not recorded yet - an admin can add Champion / Runner-up / MVP via ✎ Edit."
          : "Honors appear here once the tournament finishes."}</p>`}
      </div>
      <div class="card series-coming">
        <h3>Season stats</h3>
        <p class="hint">Detailed stats for this tournament are coming soon. Meanwhile, hit <strong>View</strong> above and the 🔨 Auction, 📅 Fixtures and 🏅 MVP tabs follow its live data.</p>
      </div>`;
  }

  function renderDetail(view, m) {
    const admin = editorOn() && cloudOn();
    const isViewing = m.id === (viewingId || LEGACY_ID);
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
          ${isViewing
            ? `<button class="btn btn-dark" disabled>✓ Viewing</button>`
            : `<button class="btn btn-yellow" data-series-view="${esc(m.id)}">View</button>`}
          ${admin ? `
          <div class="series-admin-row">
            <button class="icon-btn" data-series-edit="${esc(m.id)}" title="Edit tournament">✎</button>
            ${m.id !== activeId ? `<button class="icon-btn" data-series-default="${esc(m.id)}" title="Make this the default tournament">★</button>` : ""}
          </div>` : ""}
        </div>
      </div>
      ${UI.form ? formHtml() : ""}
      ${detailBodyHtml(m)}`;
    const holder = view.querySelector(".series-archive");
    if (holder && window.HCCLSeasonArchive) window.HCCLSeasonArchive.mount(holder);
    else if (window.HCCLSeasonArchive) window.HCCLSeasonArchive.unmount();
  }

  function render() {
    const view = document.getElementById("view-series");
    if (!view) return;
    // Detail mode - unless the tournament vanished from the registry.
    if (UI.detail && !metaOf(UI.detail)) UI.detail = null;
    if (UI.detail) { renderDetail(view, metaOf(UI.detail)); return; }
    if (window.HCCLSeasonArchive) window.HCCLSeasonArchive.unmount();
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
    const tabs = document.getElementById("tabs");
    if (tabs) tabs.addEventListener("click", e => { if (e.target.closest('[data-tab="series"]')) render(); });
    if (window.HCCL && typeof window.HCCL.onChange === "function") window.HCCL.onChange(onAuth);
    onAuth();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
