/* ============================================================
   HC News feed  (window.HCCLNews - renders into #homeNews)

   The official news board on the Home page. Moderators/admins get
   a composer (text + optional image) and can post; every signed-in
   user reads. Posts carry the author's Google display name + photo.
   Deliberately NOT a social timeline: no comments, no likes, no
   edits - just announcements, newest first.

   Firestore: news/{postId} = { text, image (dataURL or ""),
     authorUid, authorName, authorPhoto, createdAt }.
   Rules: read signedIn; create canEdit (own uid only); delete
   admin or the author; update never.

   Loads after home.js (which builds the #homeNews shell) and
   reuses app.js globals (toast, fileToDataURL).
   ============================================================ */
(function () {
  "use strict";

  const MAX_TEXT = 2000;
  // Firestore documents cap at 1 MiB - leave headroom for the other fields.
  const MAX_IMAGE_CHARS = 700 * 1024;

  const H = () => window.HCCL;
  const cloudOn = () => { const h = H(); return !!(h && h.configured && h.user && h.db && h.fs); };
  const canPost = () => { const h = H(); return cloudOn() && h.canEdit && h.canEdit(); };

  let posts = [];        // [{ id, text, image, authorUid, authorName, authorPhoto, createdAt }]
  let unsub = null;
  let loaded = false;    // first snapshot arrived (distinguishes "loading" from "no news")
  let busy = false;      // a post is being submitted
  // Composer draft survives re-renders (snapshots rebuild the whole section).
  let draftText = "";
  let draftImage = "";   // resized dataURL, ready to publish

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
      ${draftImage ? `<div class="news-attach"><img src="${draftImage}" alt="" /><button class="icon-btn del" data-news-clear-img title="Remove image">✕</button></div>` : ""}
      <div class="news-composer-bar">
        <label class="btn btn-dark file-btn">🖼 Add image
          <input type="file" class="news-image-file" accept="image/*" hidden />
        </label>
        <button class="btn btn-yellow" data-news-post ${busy ? "disabled" : ""}>${busy ? "Posting…" : "Post"}</button>
      </div>
    </div>`;
  }

  function postHtml(p) {
    const h = H();
    const mine = h.user && h.user.uid === p.authorUid;
    const canDelete = (h.isAdmin && h.isAdmin()) || (mine && h.canEdit && h.canEdit());
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
      ${p.image ? `<img class="news-img" src="${p.image}" alt="" loading="lazy" />` : ""}
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
      <div class="news-head"><h2 class="news-title">📰 HC News</h2></div>
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
        image: draftImage || "",
        authorUid: h.user.uid,
        authorName: h.user.displayName || h.user.email || "",
        authorPhoto: h.user.photoURL || "",
        createdAt: fs.serverTimestamp ? fs.serverTimestamp() : Date.now(),
      });
      draftText = ""; draftImage = "";
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

  async function pickImage(file) {
    if (!file) return;
    if (typeof window.fileToDataURL !== "function") { notify("Image helper unavailable.", "bad"); return; }
    try {
      const url = await fileToDataURL(file, 900, "jpeg");
      if (url.length > MAX_IMAGE_CHARS) { notify("That image is too large even after resizing - try a smaller one.", "bad"); return; }
      draftImage = url;
      render();
    } catch (e) {
      console.error(e);
      notify("Couldn't read that image.", "bad");
    }
  }

  /* ------------------------- events ------------------------- */
  // Delegated at the document level (the #homeNews shell is rebuilt by home.js,
  // so listeners on it wouldn't survive - same pattern as series.js).
  function onClick(e) {
    if (e.target.closest("[data-news-post]")) { submitPost(); return; }
    const del = e.target.closest("[data-news-del]");
    if (del) { deletePost(del.getAttribute("data-news-del")); return; }
    if (e.target.closest("[data-news-clear-img]")) { draftImage = ""; render(); return; }
  }

  function onInput(e) {
    const inp = e.target.closest(".news-input");
    if (inp) draftText = inp.value;
  }

  function onFileChange(e) {
    const inp = e.target.closest(".news-image-file");
    if (inp && inp.files && inp.files[0]) { pickImage(inp.files[0]); inp.value = ""; }
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
