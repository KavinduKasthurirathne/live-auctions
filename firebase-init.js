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
  collection, getDocs, writeBatch, query, orderBy, limit, increment,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAnalytics, logEvent, setUserId, isSupported,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-analytics.js";

// GA4 debug: ?analytics_debug=1 (or localStorage hccl_analytics_debug=1) mirrors
// every tracked event to the console AND stamps debug_mode so events surface in
// the Firebase Analytics DebugView in real time.
const ANALYTICS_DEBUG = /[?&]analytics_debug=1/.test(location.search)
  || (() => { try { return localStorage.getItem("hccl_analytics_debug") === "1"; } catch (e) { return false; } })();

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
  // GA4 tracking - real implementations wired up once Analytics initializes
  // (see below). No-ops until then, and in offline/unconfigured mode, so any
  // classic script may call them unconditionally.
  track() {}, trackPageView() {}, setAnalyticsUser() {},
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
  if (!H.ready) { box.innerHTML = `<span class="auth-connecting" role="status"><span class="skel skel-avatar" aria-hidden="true"></span><span class="sr-only">Connecting…</span></span>`; return; }
  if (!H.user) {
    box.innerHTML = `<button class="auth-btn" id="authSignIn">Sign in</button>`;
    const b = document.getElementById("authSignIn"); if (b) b.onclick = () => H.signIn();
  } else {
    const who = H.user.displayName || H.user.email || "";
    const initial = esc((who.trim()[0] || "?").toUpperCase());
    box.innerHTML = `<div class="auth-user">
        ${H.user.photoURL ? `<img src="${esc(H.user.photoURL)}" alt="" referrerpolicy="no-referrer"/>`
          : `<span class="auth-avatar" style="display:grid;place-items:center;font-weight:700;font-size:13px">${initial}</span>`}
        <div class="auth-meta">
          <span class="auth-name">${esc(who)}</span>
          <span class="auth-role role-${esc(H.role)}">${esc(H.role)}</span>
        </div>
        <button class="auth-btn ghost" id="authSignOut" aria-label="Sign out" title="Sign out">
          <svg class="ico" aria-hidden="true"><use href="#i-log-out"></use></svg><span class="auth-btn-label">Sign out</span>
        </button>
      </div>`;
    // Role management moved to the 📈 Members tab (js/members.js), which admins
    // and moderators share - no header popup any more.
    const b = document.getElementById("authSignOut"); if (b) b.onclick = () => H.signOut();
  }
}

/* Role hierarchy - shared by setMemberRole() below and the 📈 Members tab.
   (The old header Members popup lived here; role management now lives in
   js/members.js, which admins and moderators both open from the nav.) */
const ROLES = ["admin", "moderator", "viewer"];

/* ---------- sign-in wall: nobody sees the app until authenticated ---------- */
let authGateEl = null;
// Mirror the header's #brandLogo (league logo image, or initials fallback) so the
// gate shows the ongoing league's badge. app.js fills #brandLogo before this runs.
function gateLogoHtml() {
  // Always use the committed assets/brand-logo.jpeg. It's the league badge and the
  // only logo guaranteed to be available before sign-in (the cloud logo isn't
  // readable yet, and a stale/broken #brandLogo background must not pre-empt it).
  // Swap assets/brand-logo.jpeg in the repo to rebrand for a new league.
  return `<div class="auth-gate-logo" style="background-image:url('assets-web/brand-logo.webp');background-size:cover;background-position:center"></div>`;
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
      <p class="gate-flagline eyebrow">
        <span class="sl-flag" role="img" aria-label="Sri Lanka"></span>
        <span class="gate-country">Sri Lanka</span>
      </p>
      <h1 class="gate-title">HC Community</h1>
      <p class="gate-tagline">Hand Cricket Champions League</p>
      <p class="gate-tags">Live Auctions · Fantasy League · Season Stats</p>
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

    // ---- Firebase Analytics (GA4) -------------------------------------------
    // Reuse the one `app` instance and the measurementId already in the config.
    // Guarded by isSupported() so unsupported environments (some in-app
    // webviews, cookie-less contexts) are a clean skip rather than a throw.
    // getAnalytics() loads gtag itself and emits the standard automatic events
    // (first_visit, session_start, user_engagement, the initial page_view).
    let analytics = null;
    window.HCCL.track = function (name, params) {
      if (!name) return;
      const p = ANALYTICS_DEBUG ? Object.assign({ debug_mode: true }, params) : (params || {});
      if (ANALYTICS_DEBUG) console.log("[GA4]", name, p);
      if (analytics) { try { logEvent(analytics, name, p); } catch (e) { console.warn("[GA4] event failed", e); } }
    };
    window.HCCL.trackPageView = function (page) {
      const name = String(page || "");
      window.HCCL.track("page_view", { page_title: name, page_path: "/" + name, page_location: location.origin + "/" + name });
      notePageVisit(name);   // engagement dashboard (Firestore, batched)
    };
    window.HCCL.setAnalyticsUser = function () {
      if (analytics && window.HCCL.user && window.HCCL.user.uid) {
        try { setUserId(analytics, window.HCCL.user.uid); } catch (e) {}
      }
    };
    isSupported().then(function (ok) {
      if (!ok) { if (ANALYTICS_DEBUG) console.warn("[GA4] unsupported environment"); return; }
      analytics = getAnalytics(app);
      window.HCCL.setAnalyticsUser(); // apply UID if the session is already signed in
    }).catch(function (e) { console.warn("[GA4] init failed", e); });
    // -------------------------------------------------------------------------

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
      signInWithPopup(auth, provider).then(r => {
        // Fires only on a deliberate popup sign-in; a redirect sign-in completes
        // in getRedirectResult below, and a silent session restore never gets here.
        if (r) window.HCCL.track("login", { method: "google" });
        return r;
      }).catch(e => {
        if (e && POPUP_FALLBACK.has(e.code)) return signInWithRedirect(auth, provider);
        console.error(e); alert("Sign-in failed: " + (e && e.message || e));
      });
    window.HCCL.signOut = () => {
      window.HCCL.track("logout");
      return signOut(auth).catch(e => console.error(e));
    };

    setPersistence(auth, browserLocalPersistence).catch(() => {});
    // Complete a redirect-based sign-in if we're returning from one.
    getRedirectResult(auth).then(r => {
      if (r && r.user) window.HCCL.track("login", { method: "google" });
    }).catch(e => { console.error(e); alert("Sign-in failed: " + (e && e.message || e)); });
    renderAuthBox(); renderAuthGate(); // "Connecting…" wall until the first auth event

    // ---- lastAccessedAt: most-recent meaningful visit -----------------------
    // Distinct from Firebase Auth's lastSignInTime: this records every time the
    // app is actually OPENED, including silent session restores (onAuthStateChanged
    // fires on those too - no re-login needed). Throttled per-uid via localStorage
    // so page reloads, multiple tabs and tab-refocus don't spam Firestore. 30 min
    // mirrors GA4's session window - a natural "new visit" boundary. Merge-safe
    // (updateDoc touches only this one field) and fire-and-forget (a failed write,
    // e.g. rules not yet published, never blocks or crashes the app).
    const ACCESS_THROTTLE_MS = 30 * 60 * 1000;
    function touchLastAccessed() {
      const u = window.HCCL.user;
      if (!u || !u.uid) return;
      const key = "hccl_last_access_" + u.uid;
      let last = 0;
      try { last = Number(localStorage.getItem(key)) || 0; } catch (e) {}
      if (Date.now() - last < ACCESS_THROTTLE_MS) return; // wrote recently - skip
      // Stamp BEFORE the write so a denied/failed write can't retry-storm on reload.
      try { localStorage.setItem(key, String(Date.now())); } catch (e) {}
      updateDoc(doc(db, "users", u.uid), { lastAccessedAt: serverTimestamp() })
        .catch(e => console.warn("lastAccessedAt update skipped:", (e && e.code) || e));
    }
    /* ---------------- engagement counters (admin/mod dashboard) ----------------
       Time spent + pages visited, on the SAME users/{uid} doc. Everything is
       accumulated LOCALLY and flushed at most once a minute (plus when the tab
       is hidden/closed) with increment() - never a write per tab switch.
       Fire-and-forget like touchLastAccessed: a denied write (rules not yet
       published) must never block or crash the app. */
    const ENGAGE_FLUSH_MS = 60 * 1000;
    let engageTimeMs = 0;      // unflushed ACTIVE ms (only while the tab is visible)
    let engagePages = {};      // unflushed per-section view counts
    let engageVisit = false;   // this session not yet counted
    let engageSince = document.visibilityState === "visible" ? Date.now() : 0;
    let engageLastFlush = 0;

    function engageAccrue() {   // bank the time since we last looked
      if (engageSince) { engageTimeMs += Math.max(0, Date.now() - engageSince); }
      engageSince = document.visibilityState === "visible" ? Date.now() : 0;
    }
    function notePageVisit(name) {
      if (!name) return;
      engagePages[name] = (engagePages[name] || 0) + 1;
      flushEngagement();        // throttled inside
    }
    function flushEngagement(force) {
      const u = window.HCCL.user;
      if (!u || !u.uid) return;
      engageAccrue();
      const pages = engagePages, ms = Math.round(engageTimeMs);
      const hasPages = Object.keys(pages).length > 0;
      if (!force && Date.now() - engageLastFlush < ENGAGE_FLUSH_MS) return;
      if (!ms && !hasPages && !engageVisit) return;   // nothing to say
      engageLastFlush = Date.now();
      engageTimeMs = 0; engagePages = {};
      const patch = {};
      if (ms) patch.timeMs = increment(ms);
      Object.keys(pages).forEach(k => { patch["pages." + k] = increment(pages[k]); });
      if (engageVisit) { patch.visits = increment(1); engageVisit = false; }
      if (!Object.keys(patch).length) return;
      updateDoc(doc(db, "users", u.uid), patch)
        .catch(e => console.warn("engagement update skipped:", (e && e.code) || e));
    }

    // Coming back to a long-open tab counts as a fresh access (still throttled).
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") { engageSince = Date.now(); touchLastAccessed(); }
      else { flushEngagement(true); }   // leaving: bank what we have
    });
    window.addEventListener("pagehide", () => flushEngagement(true));
    setInterval(() => flushEngagement(), ENGAGE_FLUSH_MS);

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
        // Record this visit. The doc exists by now (just created above, or already
        // present); throttled + fire-and-forget so it never delays or breaks sign-in.
        touchLastAccessed();
        engageVisit = true;                 // count one session
        engageSince = document.visibilityState === "visible" ? Date.now() : 0;
        flushEngagement(true);
      } else {
        window.HCCL.user = null;
        window.HCCL.role = "none";
      }
      window.HCCL.setAnalyticsUser(); // attach the non-PII Firebase UID to GA4 (no-op if signed out)
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
