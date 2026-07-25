/* ============================================================
   Firebase bootstrap (ES module via CDN - no build step).
   Phase B: Google sign-in + role provisioning (users/{uid}).
   Exposes a small window.HCCL API that later phases (real-time
   data sync) build on. If config is missing, the app keeps
   working fully offline (localStorage) as before.
   ============================================================ */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  signOut, onAuthStateChanged, setPersistence, browserLocalPersistence,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, getDoc, setDoc, updateDoc, deleteDoc, deleteField, onSnapshot, serverTimestamp,
  collection, getDocs, writeBatch, query, orderBy, limit,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const listeners = new Set();
function emit() { listeners.forEach(cb => { try { cb(window.HCCL); } catch (e) { console.error(e); } }); }

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Public API used by app.js / fantasy.js (and later phases)
window.HCCL = {
  configured: false,
  ready: false,
  user: null,            // { uid, email, displayName, photoURL }
  role: "none",          // none | viewer | moderator | admin
  canEdit() { return this.role === "admin" || this.role === "moderator"; },
  isAdmin() { return this.role === "admin"; },
  onChange(cb) { listeners.add(cb); if (this.ready) cb(this); return () => listeners.delete(cb); },
  signIn() {}, signOut() {},
  listMembers() { return Promise.resolve([]); },     // admin: read all users/{uid}
  setMemberRole() { return Promise.resolve(); },     // admin: change a user's role
  db: null,
  fs: null,              // Firestore fns for later phases (doc, getDoc, onSnapshot, …)
};

function notify(msg, kind) {
  if (typeof window.toast === "function") window.toast(msg, kind);
  else console.log("[HCCL]", msg);
}

function renderAuthBox() {
  const box = document.getElementById("authBox");
  if (!box) return;
  const H = window.HCCL;
  if (!H.configured) { box.innerHTML = ""; return; }
  if (!H.ready) { box.innerHTML = `<span class="auth-connecting">Connecting…</span>`; return; }
  if (!H.user) {
    box.innerHTML = `<button class="auth-btn" id="authSignIn">Sign in with Google</button>`;
    const b = document.getElementById("authSignIn"); if (b) b.onclick = () => H.signIn();
  } else {
    box.innerHTML = `<div class="auth-user">
        ${H.user.photoURL ? `<img src="${esc(H.user.photoURL)}" alt="" referrerpolicy="no-referrer"/>` : ""}
        <div class="auth-meta">
          <span class="auth-name">${esc(H.user.displayName || H.user.email || "")}</span>
          <span class="auth-role role-${esc(H.role)}">${esc(H.role)}</span>
        </div>
        ${H.isAdmin() ? `<button class="auth-btn ghost" id="authMembers">👤 Members</button>` : ""}
        <button class="auth-btn ghost" id="authSignOut">Sign out</button>
      </div>`;
    const mb = document.getElementById("authMembers"); if (mb) mb.onclick = openMembers;
    const b = document.getElementById("authSignOut"); if (b) b.onclick = () => H.signOut();
  }
}

/* ---------- admin: Members & Roles screen ---------- */
const ROLES = ["admin", "moderator", "viewer"]; // hierarchy order
let membersBackdrop = null;

function buildMembersModal() {
  membersBackdrop = document.createElement("div");
  membersBackdrop.className = "members-backdrop hidden";
  membersBackdrop.innerHTML = `
    <div class="members-modal" role="dialog" aria-modal="true">
      <div class="members-head">
        <h3>Members &amp; Roles</h3>
        <button class="auth-btn ghost" id="membersClose">Close</button>
      </div>
      <div class="members-list" id="membersList"></div>
    </div>`;
  document.body.appendChild(membersBackdrop);

  membersBackdrop.addEventListener("click", (e) => {
    if (e.target === membersBackdrop || e.target.id === "membersClose") membersBackdrop.classList.add("hidden");
  });
  membersBackdrop.addEventListener("change", async (e) => {
    const sel = e.target.closest(".member-role-select");
    if (!sel) return;
    const uid = sel.getAttribute("data-uid");
    const role = sel.value;
    const prev = sel.getAttribute("data-prev") || "viewer";
    sel.disabled = true;
    try {
      await window.HCCL.setMemberRole(uid, role);
      sel.setAttribute("data-prev", role);
      notify(`Role updated to ${role}`, "good");
      if (window.HCCL.user && window.HCCL.user.uid === uid) {
        // Changed my own role - reflect it immediately.
        window.HCCL.role = role; applyRoleAttr(); renderAuthBox();
      }
    } catch (err) {
      console.error(err);
      sel.value = prev; // revert the dropdown
      notify("Couldn't update role (need admin + published rules)", "bad");
    } finally {
      sel.disabled = false;
    }
  });
}

function memberRowHtml(m) {
  const isSelf = window.HCCL.user && window.HCCL.user.uid === m.uid;
  const initial = esc((m.displayName || m.email || "?").slice(0, 1).toUpperCase());
  const avatar = m.photoURL
    ? `<img src="${esc(m.photoURL)}" alt="" referrerpolicy="no-referrer"/>`
    : `<div class="member-avatar">${initial}</div>`;
  return `<div class="member-row">
      ${avatar}
      <div class="member-meta">
        <span class="member-name">${esc(m.displayName || "(no name)")}${isSelf ? " · you" : ""}</span>
        <span class="member-email">${esc(m.email || "")}</span>
      </div>
      <select class="member-role-select" data-uid="${esc(m.uid)}" data-prev="${esc(m.role || "viewer")}">
        ${ROLES.map(r => `<option value="${r}" ${m.role === r ? "selected" : ""}>${r}</option>`).join("")}
      </select>
    </div>`;
}

async function refreshMembers() {
  const list = document.getElementById("membersList");
  if (!list) return;
  list.innerHTML = `<p class="members-hint">Loading…</p>`;
  try {
    const members = await window.HCCL.listMembers();
    members.sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || (a.email || "").localeCompare(b.email || ""));
    list.innerHTML = members.map(memberRowHtml).join("") || `<p class="members-hint">No members yet.</p>`;
  } catch (e) {
    console.error(e);
    list.innerHTML = `<p class="members-hint">Couldn't load members. If the console shows <b>ERR_BLOCKED_BY_CLIENT</b> or "client is offline", an ad-blocker / privacy shield is blocking Firestore - allow this site, then retry.</p>`;
  }
}

async function openMembers() {
  if (!window.HCCL.isAdmin()) return;
  if (!membersBackdrop) buildMembersModal();
  membersBackdrop.classList.remove("hidden");
  refreshMembers();
}

/* ---------- sign-in wall: nobody sees the app until authenticated ---------- */
let authGateEl = null;
// Mirror the header's #brandLogo (league logo image, or initials fallback) so the
// gate shows the ongoing league's badge. app.js fills #brandLogo before this runs.
function gateLogoHtml() {
  // Always use the committed assets/brand-logo.jpeg. It's the league badge and the
  // only logo guaranteed to be available before sign-in (the cloud logo isn't
  // readable yet, and a stale/broken #brandLogo background must not pre-empt it).
  // Swap assets/brand-logo.jpeg in the repo to rebrand for a new league.
  return `<div class="auth-gate-logo" style="background-image:url('assets/brand-logo.jpeg');background-size:cover;background-position:center"></div>`;
}
function renderAuthGate() {
  const H = window.HCCL;
  // Lock the whole app whenever Firebase is configured and we don't yet have a
  // signed-in user (connecting, or signed out). Offline mode (no config) is open.
  const locked = !!H.configured && !(H.ready && H.user);
  document.body.classList.toggle("app-locked", locked);
  if (!locked) { if (authGateEl) authGateEl.classList.add("hidden"); return; }
  if (!authGateEl) {
    authGateEl = document.createElement("div");
    authGateEl.className = "auth-gate";
    document.body.appendChild(authGateEl);
  }
  authGateEl.classList.remove("hidden");
  // Split landing: branded hero on the left, Google sign-in on the right.
  const panel = !H.ready
    ? `<p class="gate-welcome">Connecting…</p><span class="gate-panel-sub">One moment</span>`
    : `<p class="gate-welcome">Welcome</p>
       <p class="gate-panel-sub">Sign in to enter the league</p>
       <button class="auth-btn" id="authGateBtn">Sign in with Google</button>`;
  authGateEl.innerHTML = `
    <div class="gate-hero">
      ${gateLogoHtml()}
      <h1 class="gate-title">HC COMMUNITY</h1>
      <p class="gate-flagline">
        <span class="sl-flag" role="img" aria-label="Sri Lanka"></span>
        <span class="gate-country">SRI LANKA</span>
      </p>
      <p class="gate-tagline">HAND CRICKET CHAMPIONS LEAGUE</p>
      <p class="gate-tags">Live Auctions · Fantasy League · Player Rankings</p>
    </div>
    <div class="gate-panel"><div class="gate-panel-card">${panel}</div></div>`;
  const b = document.getElementById("authGateBtn"); if (b) b.onclick = () => H.signIn();
}

function applyRoleAttr() {
  const H = window.HCCL;
  document.body.dataset.role = H.role;
  // Editors (admin/moderator) get .can-edit, which reveals the edit/control UI.
  // Fully-offline mode (no Firebase configured) also gets it so the app still
  // works without any sign-in, exactly as before.
  document.body.classList.toggle("can-edit", !H.configured || H.canEdit());
}

try {
  const cfg = window.FIREBASE_CONFIG;
  const configured = cfg && cfg.apiKey && !String(cfg.apiKey).startsWith("PASTE") && cfg.projectId;
  if (!configured) {
    applyRoleAttr(); // offline mode: enable editing (no auth gate)
    renderAuthBox(); renderAuthGate();
  } else {
    const app = initializeApp(cfg);
    const auth = getAuth(app);
    // Auto-detect long-polling: falls back from the streaming WebChannel to
    // plain XHR long-polling on restrictive networks/proxies. (Does NOT defeat
    // a deliberate ad-block rule on firestore.googleapis.com - that needs the
    // user to whitelist the site.)
    //
    // Persistent (IndexedDB) cache: onSnapshot then fires IMMEDIATELY from disk
    // on a repeat visit, so the app paints before the network is even consulted
    // and an offline reload shows real data instead of an empty board. Must use
    // the MULTI-tab manager - the single-tab one throws the moment a second tab
    // is opened. Falls back to the in-memory cache where IndexedDB is
    // unavailable (private browsing, locked-down browsers).
    let db;
    try {
      db = initializeFirestore(app, {
        localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
        experimentalAutoDetectLongPolling: true,
      });
    } catch (e) {
      console.warn("persistent cache unavailable, using in-memory cache:", e);
      db = getFirestore(app);
    }
    const provider = new GoogleAuthProvider();

    window.HCCL.configured = true;
    window.HCCL.db = db;
    window.HCCL.fs = { doc, getDoc, setDoc, updateDoc, deleteDoc, deleteField, onSnapshot, serverTimestamp, collection, getDocs, writeBatch, query, orderBy, limit };
    window.HCCL.listMembers = async () => {
      const snap = await getDocs(collection(db, "users"));
      return snap.docs.map(d => ({ uid: d.id, ...d.data() }));
    };
    window.HCCL.setMemberRole = async (uid, role) => {
      if (!ROLES.includes(role)) throw new Error("invalid role");
      await updateDoc(doc(db, "users", uid), { role });
    };
    // Popup first (nicer UX); if the browser blocks it, fall back to a
    // full-page redirect, which popup blockers can't stop.
    const POPUP_FALLBACK = new Set(["auth/popup-blocked", "auth/popup-closed-by-user", "auth/cancelled-popup-request", "auth/operation-not-supported-in-this-environment"]);
    window.HCCL.signIn = () =>
      signInWithPopup(auth, provider).catch(e => {
        if (e && POPUP_FALLBACK.has(e.code)) return signInWithRedirect(auth, provider);
        console.error(e); alert("Sign-in failed: " + (e && e.message || e));
      });
    window.HCCL.signOut = () => signOut(auth).catch(e => console.error(e));

    setPersistence(auth, browserLocalPersistence).catch(() => {});
    // Complete a redirect-based sign-in if we're returning from one.
    getRedirectResult(auth).catch(e => { console.error(e); alert("Sign-in failed: " + (e && e.message || e)); });
    renderAuthBox(); renderAuthGate(); // "Connecting…" wall until the first auth event

    onAuthStateChanged(auth, async (user) => {
      if (user) {
        const owner = (window.HCCL_ADMIN_EMAILS || []).includes(user.email);
        let role = "viewer";
        try {
          const ref = doc(db, "users", user.uid);
          let snap = await getDoc(ref);
          if (!snap.exists()) {
            await setDoc(ref, {
              email: user.email || "",
              displayName: user.displayName || "",
              photoURL: user.photoURL || "",
              role: owner ? "admin" : "viewer",
              createdAt: serverTimestamp(),
            });
            snap = await getDoc(ref);
          } else if (owner && snap.data().role !== "admin") {
            // Self-heal: the bootstrap owner is ALWAYS admin. (A viewer doc can
            // get created during an earlier half-finished sign-in.)
            await updateDoc(ref, { role: "admin" });
            snap = await getDoc(ref);
          }
          role = (snap.exists() && snap.data().role) || "viewer";
        } catch (e) {
          console.error("role provisioning failed (did you publish firestore.rules?)", e);
        }
        // The bootstrap owner is ALWAYS admin in the UI, even if the role write
        // was blocked (e.g. rules not published yet) - so the owner is never
        // locked out of the controls.
        if (owner) role = "admin";
        window.HCCL.user = { uid: user.uid, email: user.email, displayName: user.displayName, photoURL: user.photoURL };
        window.HCCL.role = role;
      } else {
        window.HCCL.user = null;
        window.HCCL.role = "none";
      }
      window.HCCL.ready = true;
      applyRoleAttr();
      renderAuthBox(); renderAuthGate();
      emit();
    });
  }
} catch (e) {
  console.error("Firebase init failed:", e);
  // Fail safe: never trap the user behind a permanent "Connecting…" wall.
  // If Firebase couldn't initialise, drop to open/offline mode (localStorage).
  window.HCCL.configured = false;
  window.HCCL.ready = true;
  applyRoleAttr();
  renderAuthBox(); renderAuthGate();
}
