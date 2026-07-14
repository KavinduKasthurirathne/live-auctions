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
- Cloud-only features (news posts, the tournaments registry, published stats
  sheets) need a signed-in Firestore — use the **fake-cloud stub** below rather
  than settling for offline empty states.

## Fake-cloud stub (drives the REAL cloud code paths offline)

Add `stub.js` to the scratch copy and inject it into `index.html` right after
`<script type="module" src="firebase-init.js">`. Modules run in order and all
finish **before** `DOMContentLoaded`, which is exactly when the classic modules
(`app/series/home/news`) call `window.HCCL.onChange(...)` — so a stub that
replaces `window.HCCL` there is the one they all bind to. (They read
`window.HCCL` lazily, never caching it, so this works.)

The stub is a signed-in admin whose `fs.onSnapshot` answers from fixtures, keyed
on the ref: tag refs in `collection()`/`doc()` (e.g. `{ __coll: "news" }`) and
branch inside `onSnapshot`. Useful branches:
- `news` → fake post docs (`{ id, data: () => ({...}) }`, `createdAt` as
  `{ toDate: () => Date }`) → the real feed, rows and story popup render.
- `tournaments` → call the **error** callback to exercise the offline seed
  fallback, or return docs to script a scenario (e.g. HCCL S06 `completed` with
  honors = "the admin ended the season"). Include a `_config` doc with the
  current `seasonSeedVersion` so the seeder stays quiet.
- `seasonStatsLive` → empty snapshot; doc refs → `{ exists: () => false }`.
Give `fs` no-op `setDoc/updateDoc/deleteDoc/getDoc/getDocs` and no `writeBatch`
(that keeps the season-stats seeder from running). Drive scenarios with a query
param the stub reads (`?scenario=finals`).

Keep the offline `firebase-config.js` as well — `firebase-init.js` still sets
`body.can-edit` in open mode, which is what un-hides editor-only UI
(`.news-composer`, `.season-stats-import` are CSS-gated, so assert with
`isVisible()`, not `count()`).

## Recipe that works

1. Copy the repo (minus `.git`) to a scratch dir — **including
   `firebase-init.js`**, which is easy to miss when copying only
   `index.html css js assets docs` (without it there's no `body.can-edit`, so
   every editor-only control is silently hidden). Blank the firebase config
   as above.
2. `npm i playwright-core` (no browser download) and launch the installed
   Chrome: `chromium.launch({ executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", headless: true })`.
3. Serve the copy with a MIME-correct static server (see gotcha #1).
4. Drive: tabs via `[data-tab="..."]` buttons; Series hub via
   `.series-card [data-series-open]` / `[data-series-back]`; home carousel via
   `[data-champs-prev/next/dot]`; season tabs `[data-season="N"]`; board tabs
   `[data-board="overall|batting|bowling"]`.
5. Capture `console`/`pageerror` events — the app logs loudly on failure. A
   clean run has zero console errors and zero 404s.

Flows worth driving after a change: home (hero, the Hall of Champions carousel —
registry-driven, 6-month window, live card first — auto-advance ~6.5s, dots),
the news list (`.news-card` rows) + story popup (`[data-news-open]`, Escape /
backdrop close), Series list → Details hubs (no View button: the card and
`[data-series-open]` open the hub; S1-S5 archive-only, S6 live with quick links,
S7 upcoming placeholder; bracket lines drawn, leaderboards, board switching),
back-and-reopen a hub (re-mount must not stack listeners), other tabs still
render, 390px mobile viewport, `reducedMotion: "reduce"` context (no autoplay).

More gotchas:
- Don't pass multi-line JS to `node -e` from PowerShell - the quoting gets
  mangled. Write driver scripts to files and `node file.js`.
- On mobile (≤900px) the nav is a hamburger drawer: click `#navToggle` first,
  then the `[data-tab]` buttons inside `#tabs`; a closed drawer's tabs are
  translated off-screen and unclickable.
- The nav drawer lives inside the sticky header's stacking context (z-index
  30) - any overlay meant to sit UNDER it must use z-index < 30.
- Full-page mobile screenshots come out wider than the viewport (the clipped
  off-screen drawer inflates CDP's content-size); check real overflow with
  `document.documentElement.scrollWidth <= clientWidth`, not screenshot width.
- To exercise the news composer offline, stub `window.HCCL` (configured, user,
  role "moderator"), add `body.can-edit`, call `HCCLNews.render()`; don't
  submit (no real Firestore).
