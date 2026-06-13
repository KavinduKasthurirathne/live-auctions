/* ============================================================
   Firebase web config for the existing "hand-cricket-league" project.
   These are PUBLIC client keys (safe to ship) — real security is
   enforced by Firestore Security Rules + Authorized domains.
   ============================================================ */
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyB1SOeZq09MSXAF_DZFOey1zutywb2TSJY",
  authDomain: "hand-cricket-league-ed0d8.firebaseapp.com",
  databaseURL: "https://hand-cricket-league-ed0d8-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "hand-cricket-league-ed0d8",
  storageBucket: "hand-cricket-league-ed0d8.firebasestorage.app",
  messagingSenderId: "635499766885",
  appId: "1:635499766885:web:c01203c75ac985e859528c",
  measurementId: "G-F64F1YN320"
};

// First admin(s) — provisioned automatically on first sign-in.
// Must match the owner email(s) in firestore.rules (isOwner()).
window.HCCL_ADMIN_EMAILS = ["kavindu.kasthu@gmail.com"];
