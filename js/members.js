/* ============================================================
   Members & Engagement  (window.HCCLMembers -> #view-members)

   An admin/moderator-only board showing everyone who has signed in at least
   once: name, email, role, first login and last access, plus how long each
   person has spent on the site and which sections they use.

   Where the numbers come from - users/{uid}:
     createdAt      first sign-in (set when the profile doc is created)
     lastAccessedAt throttled last-visit stamp
     timeMs         accumulated ACTIVE time (tab visible), incremented in batches
     visits         session count
     pages          { home: 12, auctions: 30, ... } section view counts
   All of those are written by firebase-init.js; this module only reads them
   (plus role changes for admins, via HCCL.setMemberRole).

   Gating: the nav pill and this whole section are hidden from viewers by the
   body:not(.can-edit) rules in styles.css, and switchTab() refuses "members"
   for non-editors - the same belt used for Setup. Firestore rules are the
   real backstop (users list/get require canEdit()).
   ============================================================ */
(function () {
  "use strict";

  const ROLES = ["admin", "moderator", "viewer"];
  let rows = [];          // [{ uid, displayName, email, role, createdAt, lastAccessedAt, timeMs, visits, pages }]
  let loaded = false;
  let loading = false;
  let errorMsg = "";

  const H = () => window.HCCL;
  const canSee = () => { const h = H(); return !!h && (!h.configured || (h.canEdit && h.canEdit())); };
  const isAdmin = () => { const h = H(); return !!h && h.isAdmin && h.isAdmin(); };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* ---------- formatting ---------- */
  // Firestore Timestamp | number | null -> Date | null
  const dateOf = ts => (ts && typeof ts.toDate === "function") ? ts.toDate()
    : (typeof ts === "number" ? new Date(ts) : null);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function dateLabel(ts) {
    const d = dateOf(ts);
    if (!d) return "—";
    return `${String(d.getDate()).padStart(2, "0")} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  }
  function agoLabel(ts) {
    const d = dateOf(ts);
    if (!d) return "never";
    const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (s < 60) return "just now";
    const p = (n, w) => `${n} ${w}${n === 1 ? "" : "s"} ago`;
    if (s < 3600) return p(Math.floor(s / 60), "min");
    if (s < 86400) return p(Math.floor(s / 3600), "hr");
    if (s < 30 * 86400) return p(Math.floor(s / 86400), "day");
    return dateLabel(ts);
  }
  // 0 -> "—", else "3h 12m" / "12m" / "45s"
  function durLabel(ms) {
    const n = Number(ms) || 0;
    if (n < 1000) return "—";
    const sec = Math.round(n / 1000);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m`;
    return `${sec}s`;
  }
  const withinDays = (ts, days) => {
    const d = dateOf(ts);
    return !!d && (Date.now() - d.getTime()) <= days * 86400000;
  };
  const avatar = r => r.photoURL
    ? `<span class="mb-avatar" style="background-image:url('${esc(r.photoURL)}')"></span>`
    : `<span class="mb-avatar fallback">${esc((r.displayName || r.email || "?").trim().slice(0, 1).toUpperCase())}</span>`;

  /* ---------- data ---------- */
  async function load(force) {
    const h = H();
    if (loading) return;
    if (loaded && !force) return;
    if (!h || !h.configured || !h.user || !h.listMembers) {
      loaded = true; errorMsg = "offline"; render(); return;
    }
    loading = true; errorMsg = ""; render();
    try {
      const list = await h.listMembers();
      rows = (list || []).map(m => ({
        uid: m.uid, displayName: m.displayName || "", email: m.email || "",
        photoURL: m.photoURL || "", role: m.role || "viewer",
        createdAt: m.createdAt || null, lastAccessedAt: m.lastAccessedAt || null,
        timeMs: Number(m.timeMs) || 0, visits: Number(m.visits) || 0,
        pages: m.pages && typeof m.pages === "object" ? m.pages : {},
      }));
      // Most recently active first - that's what you scan a dashboard for.
      rows.sort((a, b) => {
        const da = dateOf(a.lastAccessedAt), db2 = dateOf(b.lastAccessedAt);
        return (db2 ? db2.getTime() : 0) - (da ? da.getTime() : 0);
      });
      loaded = true;
    } catch (e) {
      console.warn("members load failed:", e && e.code);
      // Almost always the rules: users list/get now need canEdit().
      errorMsg = (e && e.code === "permission-denied")
        ? "Couldn't read the member list. Publish the updated firestore.rules (users list/get now allow moderators)."
        : "Couldn't load members.";
      rows = [];
      loaded = true;
    }
    loading = false;
    render();
  }

  /* ---------- rendering ---------- */
  function tiles() {
    const total = rows.length;
    const today = rows.filter(r => withinDays(r.lastAccessedAt, 1)).length;
    const week = rows.filter(r => withinDays(r.lastAccessedAt, 7)).length;
    const totalTime = rows.reduce((s, r) => s + r.timeMs, 0);
    const tile = (k, v) => `<div class="mb-tile"><span class="mb-tile-k">${esc(k)}</span><span class="mb-tile-v">${esc(v)}</span></div>`;
    return `<div class="mb-tiles">
      ${tile("Total users", String(total))}
      ${tile("Active today", String(today))}
      ${tile("Active this week", String(week))}
      ${tile("Time on site", durLabel(totalTime))}
    </div>`;
  }

  function roleCell(r) {
    if (!isAdmin()) return `<span class="mb-role role-${esc(r.role)}">${esc(r.role)}</span>`;
    return `<select class="mb-role-select" data-mb-role="${esc(r.uid)}" data-prev="${esc(r.role)}">
      ${ROLES.map(x => `<option value="${x}"${r.role === x ? " selected" : ""}>${x}</option>`).join("")}
    </select>`;
  }

  function table() {
    if (!rows.length) return `<p class="hint">${esc(errorMsg || "No members yet.")}</p>`;
    const me = H() && H().user ? H().user.uid : "";
    return `<div class="mb-table-wrap"><table class="mb-table">
      <thead><tr>
        <th>Member</th><th>Email</th><th>Role</th><th>First logged in</th><th>Last accessed</th>
      </tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td><span class="mb-who">${avatar(r)}<span class="mb-name">${esc(r.displayName || "(no name)")}${r.uid === me ? " · you" : ""}</span></span></td>
        <td class="mb-email">${esc(r.email)}</td>
        <td>${roleCell(r)}</td>
        <td>${esc(dateLabel(r.createdAt))}</td>
        <td>${esc(agoLabel(r.lastAccessedAt))}<span class="mb-sub">${esc(dateLabel(r.lastAccessedAt))}</span></td>
      </tr>`).join("")}</tbody>
    </table></div>`;
  }

  // One card per member: time spent, sessions, and the sections they actually use.
  function engagementCards() {
    if (!rows.length) return "";
    const ranked = rows.slice().sort((a, b) => b.timeMs - a.timeMs);
    const max = Math.max(1, ranked[0].timeMs);
    return `<div class="mb-cards">${ranked.map(r => {
      const pages = Object.entries(r.pages).sort((a, b) => b[1] - a[1]).slice(0, 4);
      const pct = Math.round((r.timeMs / max) * 100);
      return `<div class="mb-card">
        <div class="mb-card-head">${avatar(r)}
          <div class="mb-card-who">
            <span class="mb-name">${esc(r.displayName || r.email || "(no name)")}</span>
            <span class="mb-sub">${esc(r.visits)} visit${r.visits === 1 ? "" : "s"} · last ${esc(agoLabel(r.lastAccessedAt))}</span>
          </div>
          <span class="mb-time">${esc(durLabel(r.timeMs))}</span>
        </div>
        <div class="mb-bar"><i style="width:${pct}%"></i></div>
        <div class="mb-pages">${pages.length
          ? pages.map(([k, v]) => `<span class="mb-page"><b>${esc(k)}</b> ${esc(v)}</span>`).join("")
          : `<span class="mb-sub">No page activity recorded yet</span>`}</div>
      </div>`;
    }).join("")}</div>`;
  }

  function render() {
    const view = document.getElementById("view-members");
    if (!view) return;
    if (!canSee()) { view.innerHTML = ""; return; }   // viewers never see content
    const h = H();
    if (h && h.configured && !h.user) {
      view.innerHTML = `<div class="view-head"><h2>MEMBERS &amp; ENGAGEMENT</h2></div>
        <p class="hint">Sign in to see member activity.</p>`;
      return;
    }
    if (h && !h.configured) {
      view.innerHTML = `<div class="view-head"><h2>MEMBERS &amp; ENGAGEMENT</h2></div>
        <p class="hint">Member activity lives in the shared cloud - it appears here once the site is connected.</p>`;
      return;
    }
    const body = loading && !rows.length
      ? `<p class="hint">Loading members…</p>`
      : `${tiles()}${errorMsg && !rows.length ? `<p class="hint">${esc(errorMsg)}</p>` : ""}${table()}
         ${rows.length ? `<h3 class="mb-h3">Time on site</h3>${engagementCards()}` : ""}`;
    view.innerHTML = `
      <div class="view-head">
        <h2>MEMBERS &amp; ENGAGEMENT</h2>
        <div class="view-head-tools"><button class="btn btn-dark" data-mb-refresh>↻ Refresh</button></div>
      </div>
      ${body}`;
  }

  /* ---------- events ---------- */
  function onClick(e) {
    if (e.target.closest("[data-mb-refresh]")) { load(true); return; }
    const tab = e.target.closest('[data-tab="members"]');
    if (tab) load();
  }
  async function onChangeEv(e) {
    const sel = e.target.closest("[data-mb-role]");
    if (!sel) return;
    const uid = sel.getAttribute("data-mb-role");
    const prev = sel.getAttribute("data-prev") || "viewer";
    const role = sel.value;
    const h = H();
    if (!h || !h.setMemberRole) return;
    sel.disabled = true;
    try {
      await h.setMemberRole(uid, role);
      sel.setAttribute("data-prev", role);
      const r = rows.find(x => x.uid === uid); if (r) r.role = role;
      if (window.toast) window.toast(`Role updated to ${role}`, "good");
      if (h.user && h.user.uid === uid) { h.role = role; }
    } catch (err) {
      console.error(err);
      sel.value = prev;
      if (window.toast) window.toast("Couldn't update role (need admin + published rules)", "bad");
    }
    sel.disabled = false;
  }

  function init() {
    document.addEventListener("click", onClick);
    document.addEventListener("change", onChangeEv);
    if (window.HCCL && typeof window.HCCL.onChange === "function") {
      window.HCCL.onChange(() => { loaded = false; rows = []; render(); if (canSee()) load(); });
    }
    render();
  }

  window.HCCLMembers = { render, load };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
