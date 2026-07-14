/* ============================================================
   HC News feed  (window.HCCLNews - renders into #homeNews)

   The official news board on the Home page, laid out like a
   cricket news site: each story is a ROW - thumbnail on the left,
   bold headline + one-line description, then date / time-ago /
   author underneath. Clicking a row opens the full story in a
   popup (every image, the whole text).

   Moderators/admins get a composer (headline + story + up to 4
   images); every signed-in user reads. Posts carry the author's
   Google display name + photo. Deliberately NOT a social timeline:
   no comments, no likes, no edits - just announcements, newest first.

   Firestore: news/{postId} = { title, text, images: [dataURL, ...],
     authorUid, authorName, authorPhoto, createdAt }. Older posts may
     carry no `title` (the headline is then the first line of the
     text) and/or a single `image` string - both still render.
   Rules: read signedIn; create canEdit (own uid only); delete
   admin or the author; update never.

   Loads after home.js (which builds the #homeNews shell) and
   reuses app.js globals (toast, fileToDataURL).
   ============================================================ */
(function () {
  "use strict";

  const MAX_TITLE = 140;
  const MAX_TEXT = 2000;
  const MAX_IMAGES = 4;
  // Firestore documents cap at 1 MiB - the COMBINED size of every attached
  // image (as dataURL text) has to leave headroom for the other fields.
  const MAX_IMAGES_CHARS = 700 * 1024;

  const H = () => window.HCCL;
  const cloudOn = () => { const h = H(); return !!(h && h.configured && h.user && h.db && h.fs); };
  const canPost = () => { const h = H(); return cloudOn() && h.canEdit && h.canEdit(); };

  let posts = [];        // [{ id, title, text, images[], authorUid, authorName, authorPhoto, createdAt }]
  let unsub = null;
  let loaded = false;    // first snapshot arrived (distinguishes "loading" from "no news")
  let busy = false;      // a post is being submitted
  let openId = null;     // story shown in the popup, or null
  // Composer draft survives re-renders (snapshots rebuild the whole section).
  let draftTitle = "";
  let draftText = "";
  let draftImages = [];  // resized dataURLs, ready to publish (max MAX_IMAGES)

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function notify(msg, kind) {
    if (typeof window.toast === "function") window.toast(msg, kind);
    else console.log("[news]", msg);
  }

  const postOf = id => posts.find(p => p.id === id) || null;

  /* ---------------------- post shape helpers ---------------------- */
  // Posts written before the composer had a headline field carry their whole
  // story in `text`; its FIRST line then serves as the headline and the rest as
  // the description, so old posts render in the new layout without a migration.
  function headline(p) {
    const t = String(p.title || "").trim();
    if (t) return t;
    const first = String(p.text || "").split(/\n/).find(l => l.trim()) || "";
    return first.trim() || "Untitled";
  }
  function body(p) {
    if (String(p.title || "").trim()) return String(p.text || "").trim();
    // No title: drop the line we promoted to the headline.
    const lines = String(p.text || "").split(/\n/);
    const i = lines.findIndex(l => l.trim());
    return lines.slice(i + 1).join("\n").trim();
  }
  // New posts carry images[]; older ones a single `image` string.
  function imagesOf(p) {
    return (Array.isArray(p.images) && p.images.length) ? p.images.slice(0, MAX_IMAGES)
      : (p.image ? [p.image] : []);
  }

  /* ---------------------- date / time helpers ---------------------- */
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  // createdAt is a Firestore Timestamp, or null while the poster's own write
  // is still pending the server clock - treat null as "now".
  const dateOf = ts => (ts && typeof ts.toDate === "function") ? ts.toDate()
    : (typeof ts === "number" ? new Date(ts) : null);

  // "14-Jul-2026" - the published date, always shown.
  function dateLabel(ts) {
    const d = dateOf(ts);
    if (!d) return "just now";
    return `${String(d.getDate()).padStart(2, "0")}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
  }
  // "3 hrs ago" - only while the story is fresh (the date carries it after a week).
  function timeAgo(ts) {
    const d = dateOf(ts);
    if (!d) return "just now";
    const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (s < 60) return "just now";
    const plur = (n, w) => `${n} ${w}${n === 1 ? "" : "s"} ago`;
    if (s < 3600) return plur(Math.floor(s / 60), "min");
    if (s < 86400) return plur(Math.floor(s / 3600), "hr");
    if (s < 7 * 86400) return plur(Math.floor(s / 86400), "day");
    return "";
  }

  const avatarHtml = (photo, name) => photo
    ? `<span class="news-avatar" style="background-image:url('${esc(photo)}')"></span>`
    : `<span class="news-avatar fallback">${esc(String(name || "?").trim().slice(0, 1).toUpperCase())}</span>`;

  const canDeletePost = p => {
    const h = H();
    if (!h || !h.user || !p) return false;
    const mine = h.user.uid === p.authorUid;
    return (h.isAdmin && h.isAdmin()) || (mine && h.canEdit && h.canEdit());
  };

  /* ------------------------- composer ------------------------- */
  function composerHtml() {
    const h = H();
    const me = h.user || {};
    return `<div class="news-composer">
      <div class="news-composer-head">
        ${avatarHtml(me.photoURL, me.displayName || me.email)}
        <div class="news-composer-fields">
          <input type="text" class="news-title-input" placeholder="Headline" maxlength="${MAX_TITLE}" value="${esc(draftTitle)}" />
          <textarea class="news-input" placeholder="Write the story…" maxlength="${MAX_TEXT}">${esc(draftText)}</textarea>
        </div>
      </div>
      ${draftImages.length ? `<div class="news-attach-grid">
        ${draftImages.map((img, i) => `<div class="news-attach">
          <img src="${img}" alt="" />
          <button class="icon-btn del" data-news-clear-img="${i}" title="Remove image">✕</button>
        </div>`).join("")}
      </div>` : ""}
      <div class="news-composer-bar">
        <label class="btn btn-dark file-btn${draftImages.length >= MAX_IMAGES ? " is-busy" : ""}">🖼 Add images${draftImages.length ? ` (${draftImages.length}/${MAX_IMAGES})` : ""}
          <input type="file" class="news-image-file" accept="image/*" multiple hidden ${draftImages.length >= MAX_IMAGES ? "disabled" : ""} />
        </label>
        <button class="btn btn-yellow" data-news-post ${busy ? "disabled" : ""}>${busy ? "Posting…" : "Publish"}</button>
      </div>
    </div>`;
  }

  /* ------------------------- feed row ------------------------- */
  // Thumbnail: a fixed-size tile that CROPS its image (background-size: cover),
  // so a portrait phone photo and a wide screenshot occupy the same slot and
  // the row height never depends on the picture.
  function thumbHtml(p) {
    const imgs = imagesOf(p);
    const extra = imgs.length > 1 ? `<span class="news-thumb-count">+${imgs.length - 1}</span>` : "";
    if (!imgs.length) return `<div class="news-thumb empty" aria-hidden="true">📰</div>`;
    return `<div class="news-thumb" style="background-image:url('${imgs[0]}')" aria-hidden="true">${extra}</div>`;
  }

  function rowHtml(p) {
    const ago = timeAgo(p.createdAt);
    const desc = body(p).replace(/\s+/g, " ").trim();
    return `<article class="news-card" data-news-open="${esc(p.id)}" tabindex="0" role="button" aria-label="Read: ${esc(headline(p))}">
      ${thumbHtml(p)}
      <div class="news-card-body">
        <h3 class="news-headline">${esc(headline(p))}</h3>
        ${desc ? `<p class="news-desc">${esc(desc)}</p>` : ""}
        <div class="news-card-meta">
          <span>${esc(dateLabel(p.createdAt))}</span>
          ${ago ? `<span class="news-dot">•</span><span>${esc(ago)}</span>` : ""}
          <span class="news-dot">•</span><span class="news-by">${esc(p.authorName || "HC Leagues")}</span>
        </div>
      </div>
      ${canDeletePost(p) ? `<button class="icon-btn del news-del" data-news-del="${esc(p.id)}" title="Delete story">🗑</button>` : ""}
    </article>`;
  }

  /* ------------------------- story popup ------------------------- */
  function modalHost() {
    let el = document.getElementById("newsModal");
    if (!el) {
      el = document.createElement("div");
      el.id = "newsModal";
      el.className = "news-backdrop hidden";
      document.body.appendChild(el);
      // Click OUTSIDE the dialog closes it.
      el.addEventListener("click", e => { if (e.target === el) closeStory(); });
    }
    return el;
  }

  function closeStory() {
    if (!openId) return;
    openId = null;
    renderModal();
  }

  function storyHtml(p) {
    const imgs = imagesOf(p);
    const ago = timeAgo(p.createdAt);
    const text = body(p);
    return `<div class="news-modal" role="dialog" aria-modal="true" aria-label="${esc(headline(p))}">
      <header class="news-modal-head">
        <h3>📰 HC Top Stories</h3>
        <button class="btn btn-dark btn-mini" data-news-close>✕ Close</button>
      </header>
      <div class="news-modal-body">
        <h2 class="news-modal-title">${esc(headline(p))}</h2>
        <div class="news-modal-meta">
          ${avatarHtml(p.authorPhoto, p.authorName)}
          <div class="news-modal-by">
            <span class="news-author">${esc(p.authorName || "HC Leagues")}</span>
            <span class="news-time">${esc(dateLabel(p.createdAt))}${ago ? ` · ${esc(ago)}` : ""}</span>
          </div>
        </div>
        ${imgs.map(src => `<img class="news-modal-img" src="${src}" alt="" />`).join("")}
        ${text ? `<p class="news-modal-text">${esc(text).replace(/\n/g, "<br>")}</p>` : ""}
      </div>
      ${canDeletePost(p) ? `<footer class="news-modal-foot">
        <button class="btn btn-dark" data-news-del="${esc(p.id)}">🗑 Delete story</button>
      </footer>` : ""}
    </div>`;
  }

  function renderModal() {
    const el = modalHost();
    const p = openId ? postOf(openId) : null;
    if (!p) { el.classList.add("hidden"); el.innerHTML = ""; return; }
    el.innerHTML = storyHtml(p);
    el.classList.remove("hidden");
  }

  /* ------------------------- rendering ------------------------- */
  function render() {
    const el = document.getElementById("homeNews");
    if (!el) return;
    const h = H();
    let feed;
    if (!h || !h.configured) {
      feed = `<p class="news-empty">News lives in the shared cloud - it appears here once the site is connected.</p>`;
    } else if (!h.user) {
      feed = `<p class="news-empty">Sign in to read the latest league news.</p>`;
    } else if (!loaded) {
      feed = `<p class="news-empty">Loading news…</p>`;
    } else if (!posts.length) {
      feed = `<p class="news-empty">No news yet - the first update will land here.</p>`;
    } else {
      feed = `<div class="news-list">${posts.map(rowHtml).join("")}</div>`;
    }
    el.innerHTML = `
      <div class="news-head"><h2 class="news-title">📰 HC Top Stories</h2></div>
      ${canPost() ? composerHtml() : ""}
      <div class="news-feed">${feed}</div>`;
    // A snapshot may have deleted the open story out from under the popup.
    if (openId && !postOf(openId)) openId = null;
    renderModal();
  }

  /* ------------------------- Firestore ------------------------- */
  function startSync() {
    if (unsub || !cloudOn()) return;
    const h = H(), fs = h.fs;
    if (!fs.collection || !fs.onSnapshot || !fs.query || !fs.orderBy || !fs.limit) return;
    unsub = fs.onSnapshot(
      fs.query(fs.collection(h.db, "news"), fs.orderBy("createdAt", "desc"), fs.limit(25)),
      snap => {
        posts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        loaded = true;
        render();
      },
      err => {
        console.warn("news snapshot error (rules published?):", err && err.code);
        loaded = true;
        render();
      });
  }

  function stopSync() {
    if (unsub) { unsub(); unsub = null; }
    posts = []; loaded = false; openId = null;
  }

  async function submitPost() {
    if (busy || !canPost()) return;
    const title = draftTitle.trim();
    const text = draftText.trim();
    if (!title && !text) { notify("Give the story a headline first.", "bad"); return; }
    // The rules require a non-empty `text`, so a headline-only post publishes
    // its headline as the text too (the story body then simply reads empty).
    const storyText = text || title;
    if (storyText.length > MAX_TEXT) { notify(`Keep the story under ${MAX_TEXT} characters.`, "bad"); return; }
    const h = H(), fs = h.fs;
    busy = true; render();
    try {
      const ref = fs.doc(fs.collection(h.db, "news")); // auto-ID
      await fs.setDoc(ref, {
        title: title || "",
        text: storyText,
        images: draftImages.slice(),
        authorUid: h.user.uid,
        authorName: h.user.displayName || h.user.email || "",
        authorPhoto: h.user.photoURL || "",
        createdAt: fs.serverTimestamp ? fs.serverTimestamp() : Date.now(),
      });
      draftTitle = ""; draftText = ""; draftImages = [];
      notify("Published to HC Top Stories.", "good");
    } catch (e) {
      console.error("news post failed:", e);
      notify("Couldn't publish - need moderator/admin + published rules.", "bad");
    }
    busy = false; render();
  }

  async function deletePost(id) {
    const h = H();
    if (!cloudOn() || !id) return;
    if (!confirm("Delete this story?")) return;
    try {
      await h.fs.deleteDoc(h.fs.doc(h.db, "news", id));
      if (openId === id) openId = null;
      renderModal();
      notify("Story deleted.", "good");
    } catch (e) {
      console.error("news delete failed:", e);
      notify("Couldn't delete the story.", "bad");
    }
  }

  async function pickImages(files) {
    if (!files || !files.length) return;
    if (typeof window.fileToDataURL !== "function") { notify("Image helper unavailable.", "bad"); return; }
    const room = MAX_IMAGES - draftImages.length;
    if (room <= 0) { notify(`Up to ${MAX_IMAGES} images per story.`, "bad"); return; }
    const picked = Array.from(files);
    if (picked.length > room) notify(`Only ${room} more image${room === 1 ? "" : "s"} fit - taking the first ${room}.`, "bad");
    let skipped = 0;
    for (const file of picked.slice(0, room)) {
      try {
        const url = await fileToDataURL(file, 900, "jpeg");
        const total = draftImages.reduce((n, u) => n + u.length, 0) + url.length;
        if (total > MAX_IMAGES_CHARS) { skipped++; continue; } // post would blow the 1MB doc cap
        draftImages.push(url);
      } catch (e) {
        console.error(e);
        skipped++;
      }
    }
    if (skipped) notify(`${skipped} image${skipped === 1 ? "" : "s"} skipped - too large for one story even after resizing.`, "bad");
    render();
  }

  /* ------------------------- events ------------------------- */
  // Delegated at the document level (the #homeNews shell is rebuilt by home.js,
  // so listeners on it wouldn't survive - same pattern as series.js).
  function onClick(e) {
    if (e.target.closest("[data-news-post]")) { submitPost(); return; }
    // Delete is checked BEFORE the row itself, so the bin never opens the story.
    const del = e.target.closest("[data-news-del]");
    if (del) { deletePost(del.getAttribute("data-news-del")); return; }
    if (e.target.closest("[data-news-close]")) { closeStory(); return; }
    const clear = e.target.closest("[data-news-clear-img]");
    if (clear) {
      const i = parseInt(clear.getAttribute("data-news-clear-img"), 10);
      if (!isNaN(i)) draftImages.splice(i, 1);
      render();
      return;
    }
    const open = e.target.closest("[data-news-open]");
    if (open) {
      const id = open.getAttribute("data-news-open");
      if (postOf(id)) { openId = id; renderModal(); }
      return;
    }
  }

  function onKeyDown(e) {
    if (e.key === "Escape" && openId) { closeStory(); return; }
    // Keyboard access to a story row (it's a button, not a link).
    if (e.key === "Enter" || e.key === " ") {
      const row = e.target.closest && e.target.closest("[data-news-open]");
      if (row) {
        e.preventDefault();
        const id = row.getAttribute("data-news-open");
        if (postOf(id)) { openId = id; renderModal(); }
      }
    }
  }

  function onInput(e) {
    const inp = e.target.closest(".news-input");
    if (inp) { draftText = inp.value; return; }
    const ttl = e.target.closest(".news-title-input");
    if (ttl) draftTitle = ttl.value;
  }

  function onFileChange(e) {
    const inp = e.target.closest(".news-image-file");
    if (inp && inp.files && inp.files.length) { pickImages(inp.files); inp.value = ""; }
  }

  function onAuth() {
    if (cloudOn()) startSync();
    else stopSync();
    render();
  }

  function init() {
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("input", onInput);
    document.addEventListener("change", onFileChange);
    if (window.HCCL && typeof window.HCCL.onChange === "function") window.HCCL.onChange(onAuth);
    render();
  }

  window.HCCLNews = { render };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
