/* ============================================================
   HC News feed  (window.HCCLNews - renders into #homeNews)

   The official news board on the Home page. Moderators/admins get
   a composer (text + up to 4 images) and can post; every signed-in
   user reads. Posts carry the author's Google display name + photo.
   Deliberately NOT a social timeline: no comments, no likes, no
   edits - just announcements, newest first.

   Firestore: news/{postId} = { text, images: [dataURL, ...],
     authorUid, authorName, authorPhoto, createdAt }. Older posts
     may carry a single `image` string instead - still rendered.
   Rules: read signedIn; create canEdit (own uid only); delete
   admin or the author; update never.

   Loads after home.js (which builds the #homeNews shell) and
   reuses app.js globals (toast, fileToDataURL).
   ============================================================ */
(function () {
  "use strict";

  const MAX_TEXT = 2000;
  const MAX_IMAGES = 4;
  // Firestore documents cap at 1 MiB - the COMBINED size of every attached
  // image (as dataURL text) has to leave headroom for the other fields.
  const MAX_IMAGES_CHARS = 700 * 1024;

  const H = () => window.HCCL;
  const cloudOn = () => { const h = H(); return !!(h && h.configured && h.user && h.db && h.fs); };
  const canPost = () => { const h = H(); return cloudOn() && h.canEdit && h.canEdit(); };

  let posts = [];        // [{ id, text, image, authorUid, authorName, authorPhoto, createdAt }]
  let unsub = null;
  let loaded = false;    // first snapshot arrived (distinguishes "loading" from "no news")
  let busy = false;      // a post is being submitted
  // Composer draft survives re-renders (snapshots rebuild the whole section).
  let draftText = "";
  let draftImages = []; // resized dataURLs, ready to publish (max MAX_IMAGES)

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function notify(msg, kind) {
    if (typeof window.toast === "function") window.toast(msg, kind);
    else console.log("[news]", msg);
  }

  // createdAt is a Firestore Timestamp, or null while the poster's own write
  // is still pending the server clock - treat null as "just now".
  function timeAgo(ts) {
    const d = ts && typeof ts.toDate === "function" ? ts.toDate() : null;
    if (!d) return "just now";
    const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
    return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
  }

  const avatarHtml = (photo, name) => photo
    ? `<span class="news-avatar" style="background-image:url('${esc(photo)}')"></span>`
    : `<span class="news-avatar fallback">${esc(String(name || "?").trim().slice(0, 1).toUpperCase())}</span>`;

  /* ------------------------- rendering ------------------------- */
  function composerHtml() {
    const h = H();
    const me = h.user || {};
    return `<div class="news-composer">
      <div class="news-composer-head">
        ${avatarHtml(me.photoURL, me.displayName || me.email)}
        <textarea class="news-input" placeholder="Share an update with the league…" maxlength="${MAX_TEXT}">${esc(draftText)}</textarea>
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
        <button class="btn btn-yellow" data-news-post ${busy ? "disabled" : ""}>${busy ? "Posting…" : "Post"}</button>
      </div>
    </div>`;
  }

  function postHtml(p) {
    const h = H();
    const mine = h.user && h.user.uid === p.authorUid;
    const canDelete = (h.isAdmin && h.isAdmin()) || (mine && h.canEdit && h.canEdit());
    // New posts carry images[]; older ones a single image string.
    const imgs = (Array.isArray(p.images) && p.images.length) ? p.images.slice(0, MAX_IMAGES)
      : (p.image ? [p.image] : []);
    return `<article class="news-item">
      <div class="news-item-head">
        ${avatarHtml(p.authorPhoto, p.authorName)}
        <div class="news-item-meta">
          <span class="news-author">${esc(p.authorName || "Unknown")}</span>
          <span class="news-time">${esc(timeAgo(p.createdAt))}</span>
        </div>
        ${canDelete ? `<button class="icon-btn del news-del" data-news-del="${esc(p.id)}" title="Delete post">🗑</button>` : ""}
      </div>
      <p class="news-text">${esc(p.text).replace(/\n/g, "<br>")}</p>
      ${imgs.length ? `<div class="news-imgs n${imgs.length}">
        ${imgs.map(src => `<img class="news-img" src="${src}" alt="" loading="lazy" />`).join("")}
      </div>` : ""}
    </article>`;
  }

  function render() {
    const el = document.getElementById("homeNews");
    if (!el) return;
    const h = H();
    let body;
    if (!h || !h.configured) {
      body = `<p class="news-empty">News lives in the shared cloud - it appears here once the site is connected.</p>`;
    } else if (!h.user) {
      body = `<p class="news-empty">Sign in to read the latest league news.</p>`;
    } else if (!loaded) {
      body = `<p class="news-empty">Loading news…</p>`;
    } else if (!posts.length) {
      body = `<p class="news-empty">No news yet - the first update will land here.</p>`;
    } else {
      body = posts.map(postHtml).join("");
    }
    el.innerHTML = `
      <div class="news-head"><h2 class="news-title">📰 HC Top Stories</h2></div>
      ${canPost() ? composerHtml() : ""}
      <div class="news-feed">${body}</div>`;
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
    posts = []; loaded = false;
  }

  async function submitPost() {
    if (busy || !canPost()) return;
    const text = draftText.trim();
    if (!text) { notify("Write something first.", "bad"); return; }
    if (text.length > MAX_TEXT) { notify(`Keep it under ${MAX_TEXT} characters.`, "bad"); return; }
    const h = H(), fs = h.fs;
    busy = true; render();
    try {
      const ref = fs.doc(fs.collection(h.db, "news")); // auto-ID
      await fs.setDoc(ref, {
        text,
        images: draftImages.slice(),
        authorUid: h.user.uid,
        authorName: h.user.displayName || h.user.email || "",
        authorPhoto: h.user.photoURL || "",
        createdAt: fs.serverTimestamp ? fs.serverTimestamp() : Date.now(),
      });
      draftText = ""; draftImages = [];
      notify("Posted to HC News.", "good");
    } catch (e) {
      console.error("news post failed:", e);
      notify("Couldn't post - need moderator/admin + published rules.", "bad");
    }
    busy = false; render();
  }

  async function deletePost(id) {
    const h = H();
    if (!cloudOn() || !id) return;
    if (!confirm("Delete this news post?")) return;
    try {
      await h.fs.deleteDoc(h.fs.doc(h.db, "news", id));
      notify("Post deleted.", "good");
    } catch (e) {
      console.error("news delete failed:", e);
      notify("Couldn't delete the post.", "bad");
    }
  }

  async function pickImages(files) {
    if (!files || !files.length) return;
    if (typeof window.fileToDataURL !== "function") { notify("Image helper unavailable.", "bad"); return; }
    const room = MAX_IMAGES - draftImages.length;
    if (room <= 0) { notify(`Up to ${MAX_IMAGES} images per post.`, "bad"); return; }
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
    if (skipped) notify(`${skipped} image${skipped === 1 ? "" : "s"} skipped - too large for one post even after resizing.`, "bad");
    render();
  }

  /* ------------------------- events ------------------------- */
  // Delegated at the document level (the #homeNews shell is rebuilt by home.js,
  // so listeners on it wouldn't survive - same pattern as series.js).
  function onClick(e) {
    if (e.target.closest("[data-news-post]")) { submitPost(); return; }
    const del = e.target.closest("[data-news-del]");
    if (del) { deletePost(del.getAttribute("data-news-del")); return; }
    const clear = e.target.closest("[data-news-clear-img]");
    if (clear) {
      const i = parseInt(clear.getAttribute("data-news-clear-img"), 10);
      if (!isNaN(i)) draftImages.splice(i, 1);
      render();
      return;
    }
  }

  function onInput(e) {
    const inp = e.target.closest(".news-input");
    if (inp) draftText = inp.value;
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
    document.addEventListener("input", onInput);
    document.addEventListener("change", onFileChange);
    if (window.HCCL && typeof window.HCCL.onChange === "function") window.HCCL.onChange(onAuth);
    render();
  }

  window.HCCLNews = { render };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
