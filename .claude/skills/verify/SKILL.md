---
name: verify
description: Verify changes to the HC Leagues static site by driving it in a headless browser (offline Firebase mode).
---

# Verifying the HC Leagues site

Static site, no build step. The surface is a browser at `index.html`.

## Gotchas learned the hard way

- `firebase-init.js` is a `type="module"` script — any local server MUST send
  `Content-Type: text/javascript` for `.js`, or the module silently fails to
  load (no auth gate, no `window.HCCL`). `python -m http.server` and any
  MIME-aware server are fine; a bare `res.writeHead(200)` node server is not.
- The repo's real `firebase-config.js` points at the production project. For
  verification, copy the site to a temp dir and overwrite `firebase-config.js`
  with `window.FIREBASE_CONFIG = { apiKey: "PASTE_OFFLINE", projectId: "" };
  window.HCCL_ADMIN_EMAILS = [];` → the app runs in open/offline mode
  (localStorage, no sign-in wall, `body.can-edit` set).
- To see the sign-in gate instead, use a fake-but-shaped config
  (`apiKey: "AIzaSy..."`, non-empty `projectId`) — the gate renders locally
  without valid credentials.
- Cloud-only features (news feed posts, multi-tournament registry, live CSV
  sync) cannot be exercised without real Google sign-in — verify their
  offline fallbacks (hints/empty states) and read the Firestore rules instead.

## Recipe that works

1. Copy the repo (minus `.git`) to a scratch dir; blank the firebase config
   as above.
2. `npm i playwright-core` (no browser download) and launch the installed
   Chrome: `chromium.launch({ executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", headless: true })`.
3. Serve the copy with a MIME-correct static server (see gotcha #1).
4. Drive: tabs via `[data-tab="..."]` buttons; Series hub via
   `.series-card [data-series-open]` / `[data-series-back]`; home carousel via
   `[data-champs-prev/next/dot]`; season tabs `[data-season="N"]`; board tabs
   `[data-board="overall|batting|bowling"]`.
5. Capture `console`/`pageerror` events — the app logs loudly on failure.
   Known benign 404: `assets/Players/Chamika Kaushila.jpeg` (photo listed in
   season-archive.js but never committed).

Flows worth driving after a change: home (hero, carousel auto-advance ~6.5s,
dots, news shell), Series list → HCCL Details hub (season tabs, podium,
bracket lines drawn, leaderboards, board switching), back-and-reopen the hub
(re-mount must not stack listeners), other tabs still render, 390px mobile
viewport, `reducedMotion: "reduce"` context (no autoplay).
