/* ============================================================
   Firebase bootstrap (ES module via CDN — no build step).
   Phase B: Google sign-in + role provisioning (users/{uid}).
   Exposes a small window.HCCL API that later phases (real-time
   data sync) build on. If config is missing, the app keeps
   working fully offline (localStorage) as before.
   ============================================================ */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged, setPersistence, browserLocalPersistence,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, onSnapshot, serverTimestamp,
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
  db: null,
  fs: null,              // { doc, getDoc, setDoc, onSnapshot, serverTimestamp } for later phases
};

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
        <button class="auth-btn ghost" id="authSignOut">Sign out</button>
      </div>`;
    const b = document.getElementById("authSignOut"); if (b) b.onclick = () => H.signOut();
  }
}

function applyRoleAttr() {
  document.body.dataset.role = window.HCCL.role; // for future CSS gating (Phases C/D)
}

try {
  const cfg = window.FIREBASE_CONFIG;
  const configured = cfg && cfg.apiKey && !String(cfg.apiKey).startsWith("PASTE") && cfg.projectId;
  if (!configured) {
    renderAuthBox();
  } else {
    const app = initializeApp(cfg);
    const auth = getAuth(app);
    const db = getFirestore(app);
    const provider = new GoogleAuthProvider();

    window.HCCL.configured = true;
    window.HCCL.db = db;
    window.HCCL.fs = { doc, getDoc, setDoc, onSnapshot, serverTimestamp };
    window.HCCL.signIn = () =>
      signInWithPopup(auth, provider).catch(e => { console.error(e); alert("Sign-in failed: " + (e && e.message || e)); });
    window.HCCL.signOut = () => signOut(auth).catch(e => console.error(e));

    setPersistence(auth, browserLocalPersistence).catch(() => {});
    renderAuthBox(); // "Connecting…" until the first auth event

    onAuthStateChanged(auth, async (user) => {
      if (user) {
        let role = "viewer";
        try {
          const ref = doc(db, "users", user.uid);
          let snap = await getDoc(ref);
          if (!snap.exists()) {
            const owner = (window.HCCL_ADMIN_EMAILS || []).includes(user.email);
            await setDoc(ref, {
              email: user.email || "",
              displayName: user.displayName || "",
              role: owner ? "admin" : "viewer",
              createdAt: serverTimestamp(),
            });
            snap = await getDoc(ref);
          }
          role = (snap.exists() && snap.data().role) || "viewer";
        } catch (e) {
          console.error("role provisioning failed (did you publish firestore.rules?)", e);
        }
        window.HCCL.user = { uid: user.uid, email: user.email, displayName: user.displayName, photoURL: user.photoURL };
        window.HCCL.role = role;
      } else {
        window.HCCL.user = null;
        window.HCCL.role = "none";
      }
      window.HCCL.ready = true;
      applyRoleAttr();
      renderAuthBox();
      emit();
    });
  }
} catch (e) {
  console.error("Firebase init failed:", e);
  renderAuthBox();
}
