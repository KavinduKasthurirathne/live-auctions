/* ============================================================
   HC News feed  (window.HCCLNews - renders into #homeNews)

   The official news board on the Home page, laid out like a
   cricket news site: each story is a ROW - thumbnail on the left,
   bold headline + one-line description, then date / time-ago /
   author underneath. Clicking a row opens the full story in a
   popup (every image, the whole text).

   Moderators/admins get a composer (headline + story + up to 4
   images); every signed-in user reads. Posts carry the author's
   Google display name + photo. Stories are never edited - delete
   and repost instead.

   Readers (viewers included) can LIKE, COMMENT and SHARE. Both the
   feed row and the story popup carry the action bar; likes show a
   count plus a "Sam and 11 others liked this" summary; comments are
   read/written in the popup; share hands out a #story=<id> deep link.

   Firestore:
     news/{postId} = { title, text, images: [dataURL, ...], authorUid,
       authorName, authorPhoto, createdAt }. Older posts may carry no
       `title` (the headline is then the first line of the text)
       and/or a single `image` string - both still render.
     news/{postId}/comments/{cid} = { uid, name, photo, text, createdAt }.
     newsLikes/{postId} = { u: { <uid>: { n, p, t } } } - ONE doc per
       story, so every story's likes arrive on a single collection
       listener. Kept out of the post doc on purpose: stories inline up
       to 700 KiB of base64 images, and a like must not rewrite (or
       re-push to every reader) that payload.
   Rules: read signedIn; post create canEdit (own uid only); post
   delete admin or the author; post update never. Comment create any
   signed-in user as themselves; comment delete its author, an admin
   or the story's author. A like may only touch its own uid key.

   Loads after home.js (which builds the #homeNews shell) and
   reuses app.js globals (toast, fileToDataURL).
   ============================================================ */
(function () {
  "use strict";

  const MAX_TITLE = 140;
  const MAX_TEXT = 2000;
  const MAX_COMMENT = 500;   // must match the rule on news/{id}/comments
  const MAX_COMMENTS = 200;  // newest stories rarely go past this; hard cap the read
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

  // ---- likes / comments / share ----
  let likes = {};             // postId -> { uid: { n, p, t } }  (whole collection)
  let likesUnsub = null;
  let comments = [];          // the OPEN story's comments, oldest first
  let commentsFor = null;     // postId `comments` belongs to
  let commentsUnsub = null;
  let commentsLoaded = false;
  let draftComment = "";      // survives modal repaints, like the composer drafts
  let commentBusy = false;
  let likersFor = null;       // "Liked by" sheet open for this postId, or null
  let renderedStoryId = null; // story the modal DOM currently shows (rebuild guard)
  let pendingStoryId = null;  // #story=<id> deep link waiting for the feed to load

  // ---- new-post notifications (no backend: in-app badge + toast + opt-in
  // native browser popup while a tab is open) ----
  const LAST_SEEN_KEY = "hccl_news_last_seen"; // newest post ts the user has seen
  const NOTIFY_KEY = "hccl_news_notify";       // "on" once they opt into popups
  let baselineMaxTs = null;                    // newest ts at first snapshot (no backlog alerts)
  const myUid = () => { const h = H(); return h && h.user ? h.user.uid : null; };
  const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
  const getLastSeen = () => +lsGet(LAST_SEEN_KEY) || 0;
  const notifyOn = () => lsGet(NOTIFY_KEY) === "on";

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

  const avatarHtml = (photo, name, cls) => photo
    ? `<span class="news-avatar${cls ? " " + cls : ""}" style="background-image:url('${esc(photo)}')"></span>`
    : `<span class="news-avatar fallback${cls ? " " + cls : ""}">${esc(String(name || "?").trim().slice(0, 1).toUpperCase())}</span>`;

  const canDeletePost = p => {
    const h = H();
    if (!h || !h.user || !p) return false;
    const mine = h.user.uid === p.authorUid;
    return (h.isAdmin && h.isAdmin()) || (mine && h.canEdit && h.canEdit());
  };

  // The comment's author, an admin, or the story's own author.
  function canDeleteComment(c, p) {
    const h = H();
    if (!h || !h.user || !c) return false;
    if (c.uid === h.user.uid) return true;
    if (h.isAdmin && h.isAdmin()) return true;
    return !!(p && p.authorUid === h.user.uid && h.canEdit && h.canEdit());
  }

  /* ---------------------- likes ---------------------- */
  // likes[postId] is the raw { uid: {n,p,t} } map straight off newsLikes/{postId}.
  const likersOf = id => {
    const map = likes[id] || {};
    return Object.keys(map)
      .map(uid => ({ uid, n: (map[uid] || {}).n || "", p: (map[uid] || {}).p || "", t: +(map[uid] || {}).t || 0 }))
      .sort((a, b) => b.t - a.t); // most recent first
  };
  const likeCount = id => Object.keys(likes[id] || {}).length;
  const iLike = id => { const me = myUid(); return !!(me && likes[id] && likes[id][me]); };

  // "You and 3 others liked this" - own like always reads first, then the most
  // recent liker. First names only; a row has no room for more.
  function likeSummary(id) {
    const me = myUid();
    const list = likersOf(id);
    if (!list.length) return "";
    const ordered = list.filter(x => x.uid === me).concat(list.filter(x => x.uid !== me));
    const nameOf = x => x.uid === me ? "You"
      : (String(x.n || "").trim().split(/\s+/)[0] || "Someone");
    if (list.length === 1) return `${nameOf(ordered[0])} liked this`;
    if (list.length === 2) return `${nameOf(ordered[0])} and ${nameOf(ordered[1])} liked this`;
    return `${nameOf(ordered[0])} and ${list.length - 1} others liked this`;
  }

  /* ---------------------- share ---------------------- */
  // A story link is just the current page plus #story=<id>; news.js opens that
  // story on load. Nothing else in the app uses the hash, so this can't collide
  // with the tab navigation.
  function storyUrl(id) {
    try {
      const u = new URL(window.location.href);
      u.hash = "story=" + encodeURIComponent(id);
      return u.toString();
    } catch (e) {
      return String(window.location.href).split("#")[0] + "#story=" + encodeURIComponent(id);
    }
  }
  function hashStoryId() {
    const m = /(?:^|[#&])story=([^&]+)/.exec(window.location.hash || "");
    try { return m ? decodeURIComponent(m[1]) : null; } catch (e) { return m ? m[1] : null; }
  }

  /* ---------------------- notification helpers ---------------------- */
  const postTs = p => { const d = dateOf(p.createdAt); return d ? d.getTime() : 0; };
  const newestTs = () => posts.reduce((m, p) => Math.max(m, postTs(p)), 0);
  // Unread = posts newer than last-seen that AREN'T my own.
  function unreadCount() {
    const seen = getLastSeen(), me = myUid();
    return posts.filter(p => p.authorUid !== me && postTs(p) > seen).length;
  }
  function updateBadge() {
    const n = cloudOn() ? unreadCount() : 0;
    const badge = document.getElementById("newsBadge");
    if (badge) {
      if (n > 0) { badge.textContent = n > 9 ? "9+" : String(n); badge.hidden = false; }
      else badge.hidden = true;
    }
    document.body.classList.toggle("has-news-unread", n > 0);
  }
  // Home is showing -> everything is "seen"; clear the badge.
  function markNewsSeen() {
    if (posts.length) lsSet(LAST_SEEN_KEY, String(newestTs()));
    updateBadge();
  }
  const homeActive = () => { const v = document.getElementById("view-home"); return !!(v && v.classList.contains("active")); };

  // A genuinely-new post (past the quiet baseline, not mine) just arrived.
  function announceNews(fresh) {
    const p = fresh[0]; // newest of the batch
    const title = headline(p);
    const extra = fresh.length > 1 ? ` (+${fresh.length - 1} more)` : "";
    notify(`📰 New story: ${title}${extra}`, "good");
    if (notifyOn() && typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        const n = new Notification("📰 " + title, {
          body: (body(p).replace(/\s+/g, " ").trim().slice(0, 140)) || "New update on HC Community",
          tag: "hccl-news-" + p.id,
          icon: "assets/brand-logo.jpeg",
        });
        n.onclick = () => { try { window.focus(); } catch (e) {} openId = p.id; renderModal(); n.close(); };
      } catch (e) { /* Notification can throw on some platforms - ignore */ }
    }
  }

  async function toggleAlerts() {
    if (typeof Notification === "undefined") { notify("This browser can't show notifications.", "bad"); return; }
    if (notifyOn()) { lsSet(NOTIFY_KEY, "off"); notify("News alerts off.", "good"); render(); return; }
    let perm = Notification.permission;
    if (perm === "default") { try { perm = await Notification.requestPermission(); } catch (e) {} }
    if (perm === "granted") { lsSet(NOTIFY_KEY, "on"); notify("News alerts on - you'll get a popup for new stories while this site is open.", "good"); }
    else { notify("Allow notifications in your browser settings to get news alerts.", "bad"); }
    render();
  }

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

  /* --------------- like / comment / share action bar ---------------
     Rendered into a [data-social-for] wrapper so a like snapshot can repaint
     JUST this markup - rebuilding the whole section (or the whole modal) on
     every like would wipe a half-typed comment. `where` is "row" or "story":
     the row keeps it to icons + the like count, the story spells the actions
     out and carries the comment count (only the open story is subscribed). */
  function socialHtml(id, where) {
    if (!cloudOn()) return "";
    const n = likeCount(id);
    const mine = iLike(id);
    const story = where === "story";
    const sum = likeSummary(id);
    const cN = (story && commentsFor === id && commentsLoaded) ? comments.length : null;
    return `<div class="news-actions">
        <button class="news-act${mine ? " liked" : ""}" data-news-like="${esc(id)}"
                aria-pressed="${mine ? "true" : "false"}" title="${mine ? "Unlike" : "Like"}"
                aria-label="${mine ? "Unlike" : "Like"} this story (${n} like${n === 1 ? "" : "s"})">
          <span class="news-act-icon" aria-hidden="true">${mine ? "❤️" : "🤍"}</span>
          <span class="news-act-label">${n ? n : ""}</span>
        </button>
        <button class="news-act" data-news-comment="${esc(id)}" title="Comment">
          <span class="news-act-icon" aria-hidden="true">💬</span>
          <span class="news-act-label">${story ? (cN === null ? "Comment" : String(cN)) : ""}</span>
        </button>
        <button class="news-act" data-news-share="${esc(id)}" title="Share this story">
          <span class="news-act-icon" aria-hidden="true">🔗</span>
          <span class="news-act-label">${story ? "Share" : ""}</span>
        </button>
      </div>
      ${sum ? `<button class="news-likes-sum" data-news-likers="${esc(id)}" title="See everyone who liked this">${esc(sum)}</button>` : ""}`;
  }

  const socialSlot = (id, where) =>
    `<div class="news-social" data-social-for="${esc(id)}" data-social-where="${where}">${socialHtml(id, where)}</div>`;

  // Repaint every action bar in place (feed rows AND the open story) - no
  // innerHTML churn anywhere else, so focus and scroll survive.
  function paintLikes() {
    document.querySelectorAll("[data-social-for]").forEach(el => {
      el.innerHTML = socialHtml(el.getAttribute("data-social-for"), el.getAttribute("data-social-where"));
    });
    renderLikers();
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
          <span class="news-dot">•</span><span class="news-by">${esc(p.authorName || "HC Community")}</span>
        </div>
        ${socialSlot(p.id, "row")}
      </div>
      ${canDeletePost(p) ? `<button class="icon-btn del news-del" data-news-del="${esc(p.id)}" title="Delete story">🗑</button>` : ""}
    </article>`;
  }

  /* ------------------------- "Liked by" sheet ------------------------- */
  function likersHost() {
    let el = document.getElementById("newsLikers");
    if (!el) {
      el = document.createElement("div");
      el.id = "newsLikers";
      el.className = "news-backdrop hidden";
      document.body.appendChild(el);
      el.addEventListener("click", e => { if (e.target === el) closeLikers(); });
    }
    return el;
  }
  function closeLikers() {
    if (!likersFor) return;
    likersFor = null;
    renderLikers();
  }
  function renderLikers() {
    const el = likersHost();
    const list = likersFor ? likersOf(likersFor) : [];
    if (!likersFor || !list.length) { el.classList.add("hidden"); el.innerHTML = ""; return; }
    const me = myUid();
    el.innerHTML = `<div class="news-modal news-likers" role="dialog" aria-modal="true" aria-label="Liked by">
      <header class="news-modal-head">
        <h3>❤️ Liked by ${list.length}</h3>
        <button class="btn btn-dark btn-mini" data-news-likers-close>✕ Close</button>
      </header>
      <div class="news-modal-body">
        ${list.map(x => `<div class="news-liker">
          ${avatarHtml(x.p, x.n, "sm")}
          <span class="news-liker-name">${esc(x.n || "Someone")}${x.uid === me ? " (you)" : ""}</span>
        </div>`).join("")}
      </div>
    </div>`;
    el.classList.remove("hidden");
  }

  /* ------------------------- comments ------------------------- */
  function commentsListHtml() {
    const p = openId ? postOf(openId) : null;
    if (commentsFor !== openId || !commentsLoaded) return `<p class="news-comments-empty">Loading comments…</p>`;
    if (!comments.length) return `<p class="news-comments-empty">No comments yet - say something.</p>`;
    return comments.map(c => {
      const when = timeAgo(c.createdAt) || dateLabel(c.createdAt);
      return `<div class="news-comment">
        ${avatarHtml(c.photo, c.name, "sm")}
        <div class="news-comment-body">
          <div class="news-comment-head">
            <span class="news-comment-name">${esc(c.name || "Someone")}</span>
            <span class="news-comment-time">${esc(when)}</span>
          </div>
          <p class="news-comment-text">${esc(c.text || "").replace(/\n/g, "<br>")}</p>
        </div>
        ${canDeleteComment(c, p) ? `<button class="icon-btn del" data-news-comment-del="${esc(c.id)}" title="Delete comment">🗑</button>` : ""}
      </div>`;
    }).join("");
  }

  // Repaints ONLY the list - never the composer, so the caret stays put.
  function paintComments() {
    const pane = document.getElementById("newsComments");
    if (pane) pane.innerHTML = commentsListHtml();
    // The story's comment count lives in the action bar.
    const bar = document.querySelector('[data-social-where="story"]');
    if (bar) bar.innerHTML = socialHtml(bar.getAttribute("data-social-for"), "story");
  }

  function commentBoxHtml() {
    const h = H();
    const me = (h && h.user) || {};
    return `<div class="news-comment-bar">
      ${avatarHtml(me.photoURL, me.displayName || me.email, "sm")}
      <textarea class="news-comment-input" rows="1" placeholder="Write a comment…" maxlength="${MAX_COMMENT}">${esc(draftComment)}</textarea>
      <button class="btn btn-yellow btn-mini" data-news-comment-post ${commentBusy ? "disabled" : ""}>${commentBusy ? "…" : "Post"}</button>
    </div>`;
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
        <h3>📰 Top Stories</h3>
        <button class="btn btn-dark btn-mini" data-news-close>✕ Close</button>
      </header>
      <div class="news-modal-body">
        <h2 class="news-modal-title">${esc(headline(p))}</h2>
        <div class="news-modal-meta">
          ${avatarHtml(p.authorPhoto, p.authorName)}
          <div class="news-modal-by">
            <span class="news-author">${esc(p.authorName || "HC Community")}</span>
            <span class="news-time">${esc(dateLabel(p.createdAt))}${ago ? ` · ${esc(ago)}` : ""}</span>
          </div>
        </div>
        ${imgs.map(src => `<img class="news-modal-img" src="${src}" alt="" />`).join("")}
        ${text ? `<p class="news-modal-text">${esc(text).replace(/\n/g, "<br>")}</p>` : ""}
        ${cloudOn() ? `${socialSlot(p.id, "story")}
        <div class="news-comments" id="newsComments">${commentsListHtml()}</div>
        ${commentBoxHtml()}` : ""}
      </div>
      ${canDeletePost(p) ? `<footer class="news-modal-foot">
        <button class="btn btn-dark" data-news-del="${esc(p.id)}">🗑 Delete story</button>
      </footer>` : ""}
    </div>`;
  }

  // Rebuild the modal DOM only when the story actually CHANGES; otherwise just
  // repaint the parts that move. render() runs on every news snapshot, and a
  // blind innerHTML there would throw away a half-typed comment (and the scroll
  // position) each time an unrelated story is published - the same trap
  // fixtures.js documents.
  function renderModal() {
    const el = modalHost();
    const p = openId ? postOf(openId) : null;
    if (!p) {
      el.classList.add("hidden"); el.innerHTML = "";
      renderedStoryId = null;
      draftComment = "";
      stopComments();
      return;
    }
    if (renderedStoryId !== p.id) {
      el.innerHTML = storyHtml(p);
      el.classList.remove("hidden");
      renderedStoryId = p.id;
    } else {
      paintLikes();
      paintComments();
    }
    watchComments(p.id);
  }

  function openStory(id, focusComment) {
    if (!postOf(id)) return;
    if (openId !== id) { openId = id; draftComment = ""; }
    renderModal();
    if (focusComment) {
      const inp = document.querySelector(".news-comment-input");
      if (inp) { inp.focus(); try { inp.scrollIntoView({ block: "center" }); } catch (e) {} }
    }
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
    const alertsBtn = (h && h.configured && h.user)
      ? `<button class="btn btn-dark btn-mini news-alerts${notifyOn() ? " on" : ""}" data-news-alerts title="Popup for new stories while this site is open">${notifyOn() ? "🔔 Alerts on" : "🔕 Get alerts"}</button>`
      : "";
    el.innerHTML = `
      <div class="news-head"><h2 class="news-title">📰 Top Stories</h2>${alertsBtn}</div>
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
        const me = myUid();
        const newest = newestTs();
        if (baselineMaxTs === null) {
          baselineMaxTs = newest; // first snapshot: no alerts for the existing backlog
        } else if (newest > baselineMaxTs) {
          const fresh = posts.filter(p => p.authorUid !== me && postTs(p) > baselineMaxTs)
            .sort((a, b) => postTs(b) - postTs(a));
          baselineMaxTs = newest;
          if (fresh.length) announceNews(fresh);
        }
        render();
        openPending();
        if (homeActive()) markNewsSeen(); else updateBadge();
      },
      err => {
        console.warn("news snapshot error (rules published?):", err && err.code);
        loaded = true;
        render();
      });
    startLikesSync();
  }

  function stopSync() {
    if (unsub) { unsub(); unsub = null; }
    posts = []; loaded = false; openId = null; baselineMaxTs = null;
    stopLikesSync();
    updateBadge();
  }

  // ONE listener covers every story's likes - the docs are tiny (no images) and
  // there is one per story, so this stays far cheaper than a listener per row.
  function startLikesSync() {
    if (likesUnsub || !cloudOn()) return;
    const h = H(), fs = h.fs;
    if (!fs.collection || !fs.onSnapshot) return;
    likesUnsub = fs.onSnapshot(
      fs.collection(h.db, "newsLikes"),
      snap => {
        const next = {};
        snap.docs.forEach(d => { next[d.id] = (d.data() || {}).u || {}; });
        likes = next;
        paintLikes();
      },
      err => {
        console.warn("news likes snapshot error (rules published?):", err && err.code);
        likes = {};
        paintLikes();
      });
  }

  function stopLikesSync() {
    if (likesUnsub) { likesUnsub(); likesUnsub = null; }
    likes = {}; likersFor = null;
    stopComments();
  }

  // Comments load only for the story that's actually open - one listener at a time.
  function watchComments(postId) {
    if (!cloudOn() || !postId) return;
    if (commentsUnsub && commentsFor === postId) return;
    stopComments();
    const h = H(), fs = h.fs;
    if (!fs.collection || !fs.onSnapshot || !fs.query || !fs.orderBy || !fs.limit) return;
    commentsFor = postId;
    commentsUnsub = fs.onSnapshot(
      fs.query(fs.collection(h.db, "news", postId, "comments"), fs.orderBy("createdAt", "asc"), fs.limit(MAX_COMMENTS)),
      snap => {
        if (commentsFor !== postId) return; // a stale listener won the race
        comments = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        commentsLoaded = true;
        paintComments();
      },
      err => {
        console.warn("news comments snapshot error (rules published?):", err && err.code);
        commentsLoaded = true;
        paintComments();
      });
  }

  function stopComments() {
    if (commentsUnsub) { commentsUnsub(); commentsUnsub = null; }
    comments = []; commentsFor = null; commentsLoaded = false;
  }

  /* ---------------- like / comment / share actions ---------------- */
  async function toggleLike(id) {
    if (!cloudOn() || !id) return;
    const h = H(), fs = h.fs, uid = h.user.uid;
    if (!fs.setDoc || !fs.updateDoc || !fs.deleteField) return;
    const mine = iLike(id);
    // Paint first, write second - Firestore rolls a rejected write back in its
    // local cache and fires a corrective snapshot, so there's nothing to undo here.
    const map = Object.assign({}, likes[id] || {});
    if (mine) delete map[uid];
    else map[uid] = { n: h.user.displayName || h.user.email || "", p: h.user.photoURL || "", t: Date.now() };
    likes[id] = map;
    paintLikes();
    const ref = fs.doc(h.db, "newsLikes", id);
    try {
      if (mine) await fs.updateDoc(ref, { ["u." + uid]: fs.deleteField() });
      else await fs.setDoc(ref, { u: { [uid]: map[uid] } }, { merge: true });
    } catch (e) {
      console.error("news like failed:", e);
      notify("Couldn't save your like.", "bad");
    }
  }

  // The Post button is the only bit of the comment bar we ever touch mid-flight -
  // rewriting the bar would take the caret with it.
  function paintCommentBusy() {
    const btn = document.querySelector("[data-news-comment-post]");
    if (btn) { btn.disabled = commentBusy; btn.textContent = commentBusy ? "…" : "Post"; }
  }

  async function submitComment() {
    if (commentBusy || !cloudOn() || !openId) return;
    const text = draftComment.trim();
    if (!text) { notify("Write something first.", "bad"); return; }
    if (text.length > MAX_COMMENT) { notify(`Keep comments under ${MAX_COMMENT} characters.`, "bad"); return; }
    const h = H(), fs = h.fs, id = openId;
    commentBusy = true; paintCommentBusy();
    try {
      const ref = fs.doc(fs.collection(h.db, "news", id, "comments")); // auto-ID
      await fs.setDoc(ref, {
        uid: h.user.uid,
        name: h.user.displayName || h.user.email || "",
        photo: h.user.photoURL || "",
        text,
        createdAt: fs.serverTimestamp ? fs.serverTimestamp() : Date.now(),
      });
      draftComment = "";
      const inp = document.querySelector(".news-comment-input");
      if (inp) inp.value = "";
    } catch (e) {
      console.error("news comment failed:", e);
      notify("Couldn't post your comment.", "bad");
    }
    commentBusy = false; paintCommentBusy();
  }

  async function deleteComment(cid) {
    const h = H();
    if (!cloudOn() || !cid || !commentsFor) return;
    if (!confirm("Delete this comment?")) return;
    try {
      await h.fs.deleteDoc(h.fs.doc(h.db, "news", commentsFor, "comments", cid));
    } catch (e) {
      console.error("news comment delete failed:", e);
      notify("Couldn't delete the comment.", "bad");
    }
  }

  // Native share sheet on phones; clipboard on desktop. The link is a deep link
  // back into this story.
  async function shareStory(id) {
    const p = postOf(id);
    if (!p) return;
    const url = storyUrl(id), title = headline(p);
    if (navigator.share) {
      try { await navigator.share({ title, text: title, url }); return; }
      catch (e) { if (e && e.name === "AbortError") return; } // user backed out
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try { await navigator.clipboard.writeText(url); notify("Link copied.", "good"); return; }
      catch (e) { /* insecure context or denied - fall through */ }
    }
    const ta = document.createElement("textarea");
    ta.value = url;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e) {}
    ta.remove();
    notify(ok ? "Link copied." : "Couldn't copy the link.", ok ? "good" : "bad");
  }

  /* ---------------- #story=<id> deep link ---------------- */
  // Opening a story never WRITES the hash - that would fight the tab nav. We
  // only read it, so a shared link lands on the right story.
  function openPending() {
    if (!pendingStoryId) return;
    if (postOf(pendingStoryId)) {
      const id = pendingStoryId;
      pendingStoryId = null;
      openStory(id);
    } else if (loaded) {
      pendingStoryId = null; // not among the newest stories - nothing to open
    }
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
      notify("Published to Top Stories.", "good");
    } catch (e) {
      console.error("news post failed:", e);
      notify("Couldn't publish - need moderator/admin + published rules.", "bad");
    }
    busy = false; render();
  }

  // Firestore doesn't cascade, so a deleted story would otherwise leave its
  // likes doc behind forever - and EVERY reader downloads the whole newsLikes
  // collection. Clear the children FIRST: the comment-delete rule reads the
  // story to check who wrote it, which no longer works once the story is gone.
  async function deletePostChildren(id) {
    const h = H(), fs = h.fs;
    try {
      const snap = await fs.getDocs(fs.collection(h.db, "news", id, "comments"));
      if (snap.size) {
        const batch = fs.writeBatch(h.db);
        snap.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
    } catch (e) { console.warn("news comment cleanup failed:", e && e.code); }
    try { await fs.deleteDoc(fs.doc(h.db, "newsLikes", id)); }
    catch (e) { console.warn("news likes cleanup failed:", e && e.code); }
  }

  async function deletePost(id) {
    const h = H();
    if (!cloudOn() || !id) return;
    if (!confirm("Delete this story?")) return;
    try {
      await deletePostChildren(id);
      await h.fs.deleteDoc(h.fs.doc(h.db, "news", id));
      if (openId === id) openId = null;
      if (likersFor === id) likersFor = null;
      renderModal();
      renderLikers();
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
    if (e.target.closest("[data-news-alerts]")) { toggleAlerts(); return; }
    // Any nav hop to Home clears the unread badge (the stories are now on screen).
    if (e.target.closest('[data-tab="home"]')) { setTimeout(markNewsSeen, 0); }
    if (e.target.closest("[data-news-post]")) { submitPost(); return; }
    // Everything nested inside a story row is checked BEFORE the row itself, so
    // the bin, the heart and the share button never also open the story.
    const del = e.target.closest("[data-news-del]");
    if (del) { deletePost(del.getAttribute("data-news-del")); return; }
    const like = e.target.closest("[data-news-like]");
    if (like) { toggleLike(like.getAttribute("data-news-like")); return; }
    const share = e.target.closest("[data-news-share]");
    if (share) { shareStory(share.getAttribute("data-news-share")); return; }
    const comment = e.target.closest("[data-news-comment]");
    if (comment) { openStory(comment.getAttribute("data-news-comment"), true); return; }
    const likers = e.target.closest("[data-news-likers]");
    if (likers) { likersFor = likers.getAttribute("data-news-likers"); renderLikers(); return; }
    if (e.target.closest("[data-news-likers-close]")) { closeLikers(); return; }
    if (e.target.closest("[data-news-comment-post]")) { submitComment(); return; }
    const cdel = e.target.closest("[data-news-comment-del]");
    if (cdel) { deleteComment(cdel.getAttribute("data-news-comment-del")); return; }
    if (e.target.closest("[data-news-close]")) { closeStory(); return; }
    const clear = e.target.closest("[data-news-clear-img]");
    if (clear) {
      const i = parseInt(clear.getAttribute("data-news-clear-img"), 10);
      if (!isNaN(i)) draftImages.splice(i, 1);
      render();
      return;
    }
    const open = e.target.closest("[data-news-open]");
    if (open) { openStory(open.getAttribute("data-news-open")); return; }
  }

  function onKeyDown(e) {
    if (e.key === "Escape") {
      if (likersFor) { closeLikers(); return; }   // the sheet sits on top of the story
      if (openId) { closeStory(); return; }
    }
    // Enter posts a comment; Shift+Enter is a newline. An empty box falls
    // through to the textarea so Enter still behaves like Enter.
    if (e.key === "Enter" && !e.shiftKey && e.target.closest && e.target.closest(".news-comment-input")) {
      if (!draftComment.trim()) return;
      e.preventDefault();
      submitComment();
      return;
    }
    // Keyboard access to a story row (it's a button, not a link). Controls
    // INSIDE the row handle their own keys - Space in the comment box must type
    // a space, not open a story.
    if (e.key === "Enter" || e.key === " ") {
      if (!e.target.closest) return;
      if (e.target.closest("button, input, textarea, select, a")) return;
      const row = e.target.closest("[data-news-open]");
      if (row) {
        e.preventDefault();
        openStory(row.getAttribute("data-news-open"));
      }
    }
  }

  function onInput(e) {
    const inp = e.target.closest(".news-input");
    if (inp) { draftText = inp.value; return; }
    const ttl = e.target.closest(".news-title-input");
    if (ttl) { draftTitle = ttl.value; return; }
    const cmt = e.target.closest(".news-comment-input");
    if (cmt) draftComment = cmt.value;
  }

  function onFileChange(e) {
    const inp = e.target.closest(".news-image-file");
    if (inp && inp.files && inp.files.length) { pickImages(inp.files); inp.value = ""; }
  }

  function onHashChange() {
    const id = hashStoryId();
    if (!id) return;
    pendingStoryId = id;
    openPending();
  }

  function onAuth() {
    if (cloudOn()) startSync();
    else stopSync();
    renderedStoryId = null; // a role change flips the delete affordances
    render();
    updateBadge();
  }

  function init() {
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("input", onInput);
    document.addEventListener("change", onFileChange);
    window.addEventListener("hashchange", onHashChange);
    pendingStoryId = hashStoryId(); // opened once the feed's first snapshot lands
    if (window.HCCL && typeof window.HCCL.onChange === "function") window.HCCL.onChange(onAuth);
    render();
  }

  window.HCCLNews = { render };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
