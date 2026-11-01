/* ============================================================
   Player Photo Library  (window.HCCLPhotoLib)

   ONE permanent, name-keyed home for player photos, in Firestore:
     photoLibrary/{key} = { name, data: <jpeg data URL>, updatedAt, updatedBy }
   key = the player's name lowercased with whitespace collapsed, so
   "Sasindu  Madushan" and "sasindu madushan" are the same player.

   Why it exists: photos used to live in two places that both needed hand
   upkeep - files under assets/Players/ (then re-run tools/gen-assets.js and
   redeploy), and per-tournament auction uploads keyed by player ID, which a
   player loses the moment he's added to the next tournament. The library is
   filled once and every tournament and every page finds the photo by name.

   Resolution for a name:  library photo  ->  bundled file  ->  ""  (callers
   draw initials). A per-tournament auction upload still beats both, at the
   call site, because someone chose it for that tournament specifically.

   Loading: a single collection listener once signed in. Firestore's
   persistent cache means it downloads once and comes from IndexedDB after
   that; photos are stored at 320px so the whole library stays light.

   Loads BEFORE app.js so forName() is usable from the first render; it has no
   load-time dependencies beyond the generated asset manifest.
   ============================================================ */
(function () {
  "use strict";

  const COLL = "photoLibrary";
  const MAX_PX = 320;          // longest edge stored - big enough for the stage card
  const QUALITY = 0.82;

  const lib = new Map();       // key -> { name, data, updatedAt }
  let unsub = null;
  let loaded = false;
  let seeding = false;
  const ui = { filter: "", busy: false };

  const BUNDLED = ((typeof window !== "undefined" && window.HCCL_ASSETS) || {}).playerPhotoIndex || {};

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  const say = (msg, kind) => { if (typeof window.toast === "function") window.toast(msg, kind); };

  /* Firestore ids can't contain "/" - and a name never should. */
  const key = name => String(name || "").trim().toLowerCase().replace(/\s+/g, " ").replace(/\//g, "-");

  const H = () => window.HCCL;
  const cloudOn = () => { const h = H(); return !!(h && h.configured && h.user && h.db && h.fs); };
  const canEdit = () => { const h = H(); return !!(h && h.canEdit && h.canEdit()); };

  /* ---------------- lookups ---------------- */
  // The manifest keys files by their raw lowercased basename (whitespace NOT
  // collapsed), so try that spelling as well as the normalised one.
  function bundled(name) {
    const raw = String(name || "").trim().toLowerCase();
    const p = BUNDLED[key(name)] || BUNDLED[raw];
    return p ? encodeURI(p) : "";
  }
  function fromLibrary(name) { const e = lib.get(key(name)); return e ? e.data : ""; }
  function forName(name) { return fromLibrary(name) || bundled(name); }
  function has(name) { return lib.has(key(name)); }

  function list() {
    return [...lib.entries()].map(([k, v]) => ({ key: k, ...v }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  /* Bundled photos the cloud library doesn't have yet. */
  function pendingBundled() {
    return Object.keys(BUNDLED).filter(k => !lib.has(key(k)));
  }

  function fire() {
    try { document.dispatchEvent(new CustomEvent("hccl:photos")); } catch (e) { /* old browser */ }
    renderPanel();
  }

  /* ---------------- sync ---------------- */
  function start() {
    if (unsub || !cloudOn()) return;
    const h = H(), fs = h.fs;
    unsub = fs.onSnapshot(fs.collection(h.db, COLL), snap => {
      lib.clear();
      snap.forEach(d => {
        const x = d.data() || {};
        if (x.data) lib.set(d.id, { name: x.name || d.id, data: x.data, updatedAt: Number(x.updatedAt) || 0 });
      });
      loaded = true;
      fire();
    }, err => {
      // Rules not published yet, most likely. Bundled photos keep working.
      console.warn("photo library:", err && err.code);
      loaded = true;
      fire();
    });
  }
  function stop() {
    if (unsub) { try { unsub(); } catch (e) { /* already gone */ } unsub = null; }
    const had = lib.size > 0;
    lib.clear(); loaded = false;
    if (had) fire(); else renderPanel();
  }

  /* ---------------- image -> small JPEG data URL ---------------- */
  function toDataUrl(blob, maxPx) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("Couldn't read that image"));
        img.onload = () => {
          let w = img.width, h = img.height;
          const m = maxPx || MAX_PX;
          if (w > h && w > m) { h = Math.round(h * m / w); w = m; }
          else if (h > m) { w = Math.round(w * m / h); h = m; }
          const c = document.createElement("canvas");
          c.width = w; c.height = h;
          const g = c.getContext("2d");
          // JPEG has no alpha: paint a dark ground so transparent PNGs don't go black-on-black.
          g.fillStyle = "#16161a"; g.fillRect(0, 0, w, h);
          g.drawImage(img, 0, 0, w, h);
          resolve(c.toDataURL("image/jpeg", QUALITY));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(blob);
    });
  }

  /* ---------------- writes (editors only) ---------------- */
  async function put(name, data, opts) {
    const nm = String(name || "").trim();
    const k = key(nm);
    if (!k) throw new Error("no-name");
    if (!data) throw new Error("no-photo");
    if (!cloudOn() || !canEdit()) throw new Error("not-allowed");
    if (opts && opts.onlyIfMissing && lib.has(k)) return false;
    const h = H();
    const doc = { name: nm, data, updatedAt: Date.now(), updatedBy: (h.user.email || h.user.uid || "") };
    await h.fs.setDoc(h.fs.doc(h.db, COLL, k), doc);
    lib.set(k, { name: nm, data, updatedAt: doc.updatedAt });   // optimistic; the listener confirms
    fire();
    return true;
  }
  async function putFile(name, file, opts) {
    return put(name, await toDataUrl(file, MAX_PX), opts);
  }
  async function remove(name) {
    if (!cloudOn() || !canEdit()) throw new Error("not-allowed");
    const h = H(), k = key(name);
    await h.fs.deleteDoc(h.fs.doc(h.db, COLL, k));
    lib.delete(k);
    fire();
  }

  /* Copy every bundled assets/Players photo the library doesn't have yet. Runs
     one at a time - 50-odd small writes don't need a burst, and a failure on
     one file mustn't abort the rest. Display names come from the file name, so
     the library keeps the capitalisation the files already have. */
  async function seedFromBundled(onProgress) {
    if (seeding) return { added: 0, failed: [] };
    seeding = true;
    const todo = pendingBundled();
    const failed = [];
    let done = 0;
    try {
      for (const k of todo) {
        const path = BUNDLED[k];
        try {
          const res = await fetch(encodeURI(path));
          if (!res.ok) throw new Error("HTTP " + res.status);
          const data = await toDataUrl(await res.blob(), MAX_PX);
          const name = path.split("/").pop().replace(/\.[^.]+$/, "").trim();
          await put(name, data);
        } catch (e) {
          console.warn("photo seed failed:", path, e);
          failed.push(k);
        }
        done++;
        if (onProgress) onProgress(done, todo.length);
      }
    } finally { seeding = false; }
    return { added: done - failed.length, failed };
  }

  /* ---------------- admin panel (Setup) ---------------- */
  function panelEl() { return document.getElementById("photoLibCard"); }

  function renderPanel() {
    const el = panelEl();
    if (!el) return;
    if (!canEdit()) { el.innerHTML = ""; el.hidden = true; return; }
    el.hidden = false;
    const head = `<h3>📸 Player Photo Library</h3>
      <p class="hint">One photo per player name, kept permanently in the cloud. Every tournament, the auction and the stats pages find it by name - no file to add, no redeploy. A photo uploaded for a player in the form above is copied here automatically if the library doesn't have one yet.</p>`;
    if (!cloudOn()) {
      el.innerHTML = head + `<p class="hint">The library lives in the shared cloud - sign in to manage it. Bundled photos still show offline.</p>`;
      return;
    }
    if (!loaded) { el.innerHTML = head + `<p class="hint">Loading the library…</p>`; return; }

    const pending = pendingBundled().length;
    const f = ui.filter.trim().toLowerCase();
    const rows = list().filter(r => !f || r.name.toLowerCase().includes(f));
    el.innerHTML = head + `
      <div class="pl-upload">
        <input type="text" id="plName" placeholder="Player name (exactly as used in squads)" autocomplete="off" />
        <input type="file" id="plFile" accept="image/*" />
        <button class="btn btn-yellow" data-pl-save ${ui.busy ? "disabled" : ""}>${ui.busy ? "Saving…" : "Save photo"}</button>
      </div>
      <div class="pl-bar">
        <span class="pl-count"><b>${lib.size}</b> photo${lib.size === 1 ? "" : "s"} in the library</span>
        ${pending ? `<button class="btn btn-dark btn-mini" data-pl-seed ${seeding ? "disabled" : ""}>${seeding ? "Copying…" : `⬆ Copy ${pending} bundled photo${pending === 1 ? "" : "s"} to the library`}</button>` : `<span class="hint">All bundled photos are in the library.</span>`}
        <input type="search" id="plFilter" placeholder="Search…" value="${esc(ui.filter)}" />
      </div>
      <div class="pl-grid">${rows.length ? rows.map(r => `
        <div class="pl-item" title="${esc(r.name)}">
          <span class="pl-thumb" style="background-image:url('${r.data}')"></span>
          <span class="pl-name">${esc(r.name)}</span>
          <button class="icon-btn del" data-pl-del="${esc(r.key)}" title="Remove from the library">✕</button>
        </div>`).join("") : `<p class="hint">${f ? "No player matches that search." : "The library is empty - copy the bundled photos above, or upload one."}</p>`}</div>`;
  }

  async function onClick(e) {
    const t = e.target;
    if (!t.closest || !panelEl() || !panelEl().contains(t)) return;
    if (t.closest("[data-pl-save]")) {
      const nameEl = document.getElementById("plName"), fileEl = document.getElementById("plFile");
      const name = nameEl ? nameEl.value.trim() : "", file = fileEl && fileEl.files[0];
      if (!name) { say("Enter the player's name", "bad"); return; }
      if (!file) { say("Choose a photo", "bad"); return; }
      ui.busy = true; renderPanel();
      try {
        const replacing = has(name);
        await putFile(name, file);
        say(replacing ? `Photo replaced for ${name}` : `Photo saved for ${name}`, "good");
      } catch (err) {
        console.error(err);
        say(err && err.code === "permission-denied"
          ? "The cloud refused it - publish the updated firestore.rules"
          : "Couldn't save that photo", "bad");
      }
      ui.busy = false; renderPanel();
      return;
    }
    if (t.closest("[data-pl-seed]")) {
      const n = pendingBundled().length;
      if (!n || !confirm(`Copy ${n} bundled player photo${n === 1 ? "" : "s"} into the cloud library?`)) return;
      renderPanel();
      const r = await seedFromBundled((d, total) => {
        const b = document.querySelector("[data-pl-seed]");
        if (b) b.textContent = `Copying… ${d}/${total}`;
      });
      say(r.failed.length ? `Copied ${r.added}; ${r.failed.length} failed (see console)` : `Copied ${r.added} photos to the library`,
        r.failed.length ? "bad" : "good");
      renderPanel();
      return;
    }
    const del = t.closest("[data-pl-del]");
    if (del) {
      const k = del.getAttribute("data-pl-del");
      const entry = lib.get(k);
      if (!confirm(`Remove ${entry ? entry.name : k}'s photo from the library?`)) return;
      try { await remove(entry ? entry.name : k); say("Removed from the library", "good"); }
      catch (err) { console.error(err); say("Couldn't remove it", "bad"); }
    }
  }
  function onInput(e) {
    if (e.target && e.target.id === "plFilter") {
      ui.filter = e.target.value;
      const pos = e.target.selectionStart;
      renderPanel();
      const f = document.getElementById("plFilter");
      if (f) { f.focus(); try { f.setSelectionRange(pos, pos); } catch (er) { /* not a text input */ } }
    }
  }

  function onAuth() { if (cloudOn()) start(); else stop(); renderPanel(); }

  function init() {
    document.addEventListener("click", onClick);
    document.addEventListener("input", onInput);
    if (window.HCCL && typeof window.HCCL.onChange === "function") window.HCCL.onChange(onAuth);
    onAuth();
  }

  window.HCCLPhotoLib = {
    key, forName, fromLibrary, bundled, has, list, pendingBundled,
    put, putFile, remove, seedFromBundled, toDataUrl,
    isLoaded: () => loaded, render: renderPanel,
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
