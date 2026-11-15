---
name: verify
description: Verify changes to the HC Community static site by driving it in a headless browser (offline Firebase mode).
---

# Verifying the HC Community site

Static site, no build step. The surface is a browser at `index.html`.

## Gotchas learned the hard way

- `firebase-init.js` is a `type="module"` script any local server MUST send
  `Content-Type: text/javascript` for `.js`, or the module silently fails to
  load (no auth gate, no `window.HCCL`). `python -m http.server` and any
  MIME-aware server are fine; a bare `res.writeHead(200)` node server is not.
- The repo's real `firebase-config.js` points at the production project. For
  verification, copy the site to a temp dir and overwrite `firebase-config.js`
  with `window.FIREBASE_CONFIG = { apiKey: "PASTE_OFFLINE", projectId: "" };
  window.HCCL_ADMIN_EMAILS = [];` → the app runs in open/offline mode
  (localStorage, no sign-in wall, `body.can-edit` set).
- To see the sign-in gate instead, use a fake-but-shaped config
  (`apiKey: "AIzaSy..."`, non-empty `projectId`) the gate renders locally
  without valid credentials.
- Cloud-only features (news posts, the tournaments registry, published stats
  sheets) need a signed-in Firestore use the **fake-cloud stub** below rather
  than settling for offline empty states.

## Fake-cloud stub (drives the REAL cloud code paths offline)

Add `stub.js` to the scratch copy and inject it into `index.html` right after
`<script type="module" src="firebase-init.js">`. Modules run in order and all
finish **before** `DOMContentLoaded`, which is exactly when the classic modules
(`app/series/home/news`) call `window.HCCL.onChange(...)` so a stub that
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

Keep the offline `firebase-config.js` as well `firebase-init.js` still sets
`body.can-edit` in open mode, which is what un-hides editor-only UI
(`.news-composer`, `.season-stats-import` are CSS-gated, so assert with
`isVisible()`, not `count()`).

## Recipe that works

1. Copy the repo (minus `.git`) to a scratch dir **including
   `firebase-init.js`**, which is easy to miss when copying only
   `index.html css js assets assets-web` (without it there's no `body.can-edit`, so
   every editor-only control is silently hidden). Blank the firebase config
   as above.
2. `npm i playwright-core` (no browser download) and launch the installed
   Chrome: `chromium.launch({ executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", headless: true })`.
3. Serve the copy with a MIME-correct static server (see gotcha #1).
4. Drive: `window.switchTab(name)` / `window.switchSubTab(name)` are globals
   (fastest), or click `#tabs [data-tab]` (desktop) / `#bottomNav [data-tab]`
   (phones). Tournament page via `.series-card[data-series-open]`,
   `[data-hub-tab]`, `[data-series-back]`, or `HCCLSeries.open(id, hubKey)`;
   season tabs `[data-season="N"]`; board tabs `[data-board="..."]`; Hall of
   Fame `[data-hof-tab]`, `[data-hof-group]`, `#hofSearch`, `.player-tile`,
   `[data-hof-back]`; any `[data-player]` opens a profile. Home shortcuts are
   `[data-home-open][data-home-hub]`. The buttons in the auction bid grid
   re-render on every bid, so click by selector (`.team-bid-btn >> nth=0`),
   never through a stored handle.
5. Capture `console`/`pageerror` events the app logs loudly on failure. A
   clean run has zero console errors and zero 404s.

Flows worth driving after a change: no horizontal overflow on every view at
390 / 768 / 1280 / 1440 (`scrollWidth <= clientWidth`); home (hero, "Live now"
card + its shortcuts, recent champions grid - static, no carousel); Hall of
Fame (records, champions filter, players search + paging, profile; profile
matches/runs/wickets must equal `HCCLSeasonArchive.careerStatsFor(name)` for a
bundled-only player); Dashboard charts (Chart.js loads on demand -
`window.Chart` is absent until the Dashboard opens); Series list → Details hubs (no View button: the card and
`[data-series-open]` open the hub; S1-S5 archive-only, S6 live with quick links,
S7 upcoming placeholder; bracket lines drawn, leaderboards, board switching),
back-and-reopen a hub (re-mount must not stack listeners), other tabs still
render, 390px mobile viewport, `reducedMotion: "reduce"` context (no autoplay).

More gotchas:
- Don't pass multi-line JS to `node -e` from PowerShell - the quoting gets
  mangled. Write driver scripts to files and `node file.js`.
- Below 1024px there is a fixed bottom tab bar (`#bottomNav`: Home,
  Tournaments, Auctions, Fantasy, More). "More" IS `#navToggle` and opens the
  off-canvas drawer (`#tabs`, relocated to `<body>`); a closed drawer is
  `visibility: hidden` and off-canvas, so its tabs are unclickable. Close paths:
  `#navClose`, `#navBackdrop`, Escape (focus returns to More). Full-page
  screenshots show the fixed bottom bar mid-page - that's the capture, not a bug.
- The header nav lives in `.header-inner`, not directly in `.app-header`; the
  drawer relocation remembers the nav's real parent (an `insertBefore` on the
  header itself throws and silently kills the rest of `wireEvents`).
- **`.app-header` is `position: sticky`, which makes it a stacking context**
  (it used to have `backdrop-filter` too - that also makes it the containing
  block for `position: fixed` descendants; keep it off). Anything meant to
  overlay the page must therefore NOT be a child of the header: app.js
  relocates `<nav id="tabs">` to `<body>` below 1024px for exactly this reason.
  Assert drawer/overlay **geometry** (`getBoundingClientRect().height ≈ innerHeight`),
  not just that clicks land: a fixed child trapped in the header still clicks
  fine, it's just the size of the navbar. That bug shipped once.
- Scroll-locking the page: put `overflow: hidden` on `<html>` only. On `<body>`
  (or both) the viewport clamps scrollY to 0 and the page jumps to the top;
  `position: fixed` on `<body>` robs the sticky header of its scrollport and
  sends it off-screen. Measured, not guessed.
- Full-page mobile screenshots come out wider than the viewport (the clipped
  off-screen drawer inflates CDP's content-size); check real overflow with
  `document.documentElement.scrollWidth <= clientWidth`, not screenshot width.
- To exercise the news composer offline, stub `window.HCCL` (configured, user,
  role "moderator"), add `body.can-edit`, call `HCCLNews.render()`; don't
  submit (no real Firestore).
