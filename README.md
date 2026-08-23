# 🏏 HCCL - Hand Cricket Champions League

A single-page web app for running a **live cricket player auction** *and* a **fantasy
league** for the Hand Cricket Champions League (HCCL). It's built with plain
HTML/CSS/JavaScript - **no build step, no framework, no bundler**. Open it and it runs.

Two ways to run, automatically chosen:

- **☁️ Live multi-device mode** - when Firebase is configured, everyone signs in with
  Google and sees the **same auction and fantasy data in real time** across phones and
  laptops. Roles control who can edit.
- **💾 Single-device mode** - with no Firebase (or if the cloud is unreachable), the app
  quietly falls back to saving everything in the browser's local storage, exactly as a
  standalone tool. Nothing is lost.

🔗 **Live site:** https://hc-champions-league.vercel.app

---

## Table of contents

- [Highlights](#highlights)
- [Sign-in & roles](#sign-in--roles)
- [Live Now (hand-cricket live scoring)](#-live-now)
- [The Auction](#-the-auction)
- [The Fantasy League](#-the-fantasy-league)
- [Player Ranking](#-player-ranking)
- [Season MVP](#-season-mvp)
- [Cloud sync (how live mode works)](#️-cloud-sync-how-live-mode-works)
- [Data, backup & reset](#-data-backup--reset)
- [Running it](#-running-it)
- [Deployment](#-deployment)
- [Firebase setup](#-firebase-setup)
- [Branding a new season](#-branding-a-new-season)
- [Project structure](#-project-structure)
- [Tech notes](#-tech-notes)

---

## Highlights

- 🔨 **Presenter-driven live auction** with team bidding, a SOLD countdown, undo, and a
  full-screen result reveal.
- 📋 **Live Squad Tracker + Safe Bid** - every team's slots, purse and budget health at a
  glance; bids are capped so no team can spend itself out of completing a 5-player squad.
- 📊 **Auction Insights tab** - live analytics, top-buys and team tables, and Chart.js
  visualisations, all derived client-side (no extra reads).
- 📈 **Optional player season stats** shown on the block; ✨ glow and pulse polish.
- 🏏 **Fantasy league** with match days, captain/vice-captain multipliers, live points,
  season leaderboards and a Player of the Season board.
- 🏅 **Season MVP** from a hybrid model - upload a STUMPS match-report PDF and the app
  parses the scorecard in-browser to rank players match-by-match and across the season.
- ☁️ **Real-time sync** via Firestore - auction and fantasy state mirror instantly to
  every signed-in device.
- 🔐 **Google sign-in with Admin / Moderator / Viewer roles** and a members screen.
- 🖼️ **Player photos & team logos in the cloud**, stored so every viewer sees them.
- 📷 **Share leaderboards as branded PNG images** (one-tap download).
- 💾 **Export / import JSON backups** any time, and a graceful offline fallback.
- 🎨 Dark **red / yellow / black** theme, custom league logo, favicon and tab title.

---

## Sign-in & roles

When Firebase is configured, a new visitor lands on a **split landing page** (branded
**HC CHAMPIONS LEAGUE** hero on the left, Google sign-in on the right) - you must sign in
before you can see anything. After signing in you land on the **🏠 Home** tab (league
hero + a sliding carousel of past seasons). The season results are **cloud-backed** the
same way rankings are: they live in Firestore at `home/seasons` (seed once, read-only) so
every device shows the same champions/MVPs, with the bundled `SEASONS` array in
`js/home.js` as the seed source and offline fallback. Season/team/player **images** ship
as committed assets under `assets/` (served by Vercel), referenced by name. Each user has
one of three roles:

| Role | Can do |
|------|--------|
| **Admin** | Everything: run the auction, edit fantasy, **and manage members/roles**. |
| **Moderator** | Create / update / delete auction **and** fantasy data. No role management. |
| **Viewer** | Read-only for auction, squads and leaderboards - no edit controls, no setup pages. **Can still enter the fantasy game**: pick and edit their own team until a match closes. |

> The role hierarchy is **admin ▸ moderator ▸ viewer**.

- The **owner email** (configured in `firestore.rules` and `firebase-config.js`) is always
  treated as an admin, even before any profile exists - it bootstraps the system.
- New users default to **Viewer**. An admin promotes them from the **👤 Members** screen
  (open it from the header chip after signing in).
- The UI gates itself by role: viewers never see edit buttons, the Setup tab, or keyboard
  auction shortcuts.

---

## 🔴 Live Now

Ball-by-ball live scoring for **hand cricket**, in the style of a broadcast scorecard.
A scorer taps a digit for every ball; everyone else watches their own phone update in
real time.

**This tab is deliberately standalone.** It shares no data with the auction, tournaments,
fixtures, fantasy or rankings — its own Firestore collection, its own teams, its own
players. Nothing you do here affects anything else in the app, and nothing elsewhere
affects it.

### The rules it encodes

- Only the digits **0 1 2 3 4 5 6**, plus **W** (bowled — the only way out). No extras,
  so every ball is legal and an over is *always* six balls.
- **Strike never rotates.** Odd runs don't swap, the end of an over doesn't swap. One
  batsman is at the crease until he's bowled, so there is no non-striker and no
  partnership — the batting card shows the current batsman starred plus everyone who
  has already batted.
- **Every wicket goes to the bowler of that over.**
- The scorer picks the incoming batsman after each wicket, and a bowler at the start of
  every over.
- An innings closes on: overs exhausted, the wickets limit reached, no batsman left, the
  target passed, or the scorer ending it early.

### Setting a match up (editors only)

**＋ New Match** asks for team names, a **playing XI per side typed one name per line**,
overs, wickets per innings, and who bats first. Title and venue are optional. Renaming a
player later is safe — the squad is re-parsed by name, so an existing player keeps his id
and every ball he has faced follows him.

### Scoring

The scoring panel sits underneath the scoreboard and only ever asks for one thing at a
time — the opening batsman, then the bowler, then the tap pad. After a wicket it asks who
is in; at the end of an over it asks who bowls the next one. **↩ Undo last** is always
available and is always exact.

### Who sees what

| | Viewer | Moderator / Admin |
|---|---|---|
| Scoreboard, ground & wagon wheel, over track, full scorecards, commentary | ✅ | ✅ |
| Create / edit / delete a match, the scoring panel, Undo, End innings | — | ✅ |

The scoring panel is CSS-gated on `body.can-edit` (the same mechanism the rest of the app
uses) *and* every write is refused by `firestore.rules` unless the caller is a moderator
or an admin — so a viewer cannot score by poking at the DOM.

### Why the score is never stored

`liveMatches/{id}` holds the match **settings** and an ordered **event list** — one small
event per ball — and never a score. Every client folds those events through the same pure
function (`js/live-engine.js`) to derive everything on screen. That is what makes Undo
exact (drop the last event and recompute — nothing to unwind by hand, so the score can
never drift out of step with the cards), keeps each write tiny, and guarantees two devices
can never disagree. Appends use Firestore's `arrayUnion`, so two scorers tapping at the
same instant both land instead of one silently overwriting the other.

Signed out or with Firebase unconfigured, the tab falls back to `localStorage`
(`hccl_live_v1`) and works exactly the same on that one device.

---

## 🔨 The Auction

### First-time setup (⚙️ Setup tab)

1. **League Settings** - season name & number (e.g. *HCCL Season 06*), currency label
   (default `Cr`), default purse per team, bid increment, and the league logo. The season
   name + number also become the **browser tab title**, and the logo becomes the
   **favicon**.
2. **Add Team** - name, purse (blank = default) and logo for each team.
3. **Add Player** - name, role/category, base price and photo. Players are auctioned
   **top-to-bottom** in this list; reorder with ▲ ▼.
4. **Retain / Pre-assign Player** *(optional)* - players a team keeps from last season.
   They go straight into that team's squad with a **RET** tag, are skipped by the auction,
   survive a "Reset auction results", and their (optional) retention price is **not**
   deducted from the new-season purse.

> New here? Click **Load sample data** to try it instantly.

### Running the auction (🔨 Live Auction tab)

- The current player appears with **photo, name and base price**.
- Each team has a **bid button**. First click bids the base price; each later click raises
  it by the increment. The leading team is highlighted and can't out-bid itself; teams that
  can't afford the next bid are disabled automatically.
- **SOLD** steps through **GOING ONCE → GOING TWICE → GOING THRICE → SELL**. A new bid
  during the countdown resets it.
- On finalize: a full-screen **"{Player} SOLD to {Team} for {Price}"** reveal, the team's
  purse drops, and their squad updates.
- **Unsold** marks a player unsold · **↩ Undo** reverts the last sold/unsold result ·
  **⟳ Reset Bid** clears the current player's bids · **Next Player ▶** advances.

#### Keyboard shortcuts (auction tab)

| Key | Action |
|-----|--------|
| `1`–`9` | Bid for team 1–9 |
| `Space` | Advance SOLD (once / twice / thrice / sell) |
| `U` | Unsold |
| `N` | Next player |
| `Z` | Undo |
| `Enter` | Next player (on the result screen) |

*(Disabled for viewers.)*

### The other auction tabs

- **👥 Players** - every player with base price and status (Available / Sold / Unsold),
  sale price and buying team. Search & filter; auction any player out of order, or
  re-auction an unsold one.
- **💰 Teams & Purse** - each team's total, spent and **remaining purse**, live.
- **🏆 Squads** - each team's logo, name and the players they bought, with prices.

### Auction intelligence (Phase E)

- **📋 Live Squad Tracker** - a card per team in the Live Auction (visible to everyone):
  player dots, `x / 5` slots, remaining purse, **Safe Bid**, average spend, and a
  green/yellow/red budget-health bar.
- **Safe Bid & smart restrictions** - every team must finish with **5 players**, so the app
  reserves enough purse to fill empty slots and **disables bids above the Safe Bid**
  (`safeBid = remainingPurse − max(0, slotsLeft−1) × cheapestAvailableBase`). A team that's
  full (5 players) can't bid.
- **📊 Insights tab** - live, read-only analytics derived entirely from local state: most
  expensive / cheapest / averages, sold-vs-unsold, completion %, money spent/remaining,
  biggest bid war, plus Top Sold Players and Team Analytics tables and Chart.js charts (price
  histogram, sold/unsold, team spending, remaining purse). Charts degrade gracefully if the
  Chart.js CDN is blocked - the numbers and tables still render.
- **📈 Season stats** - players can carry optional historical stats (matches, runs, wickets,
  strike rate, economy, average, fantasy points, previous price), entered in the player form
  under *Season stats (optional)* and shown as a card under the photo during the auction.
- **✨ Polish** - glow and pulse animations.

---

## 🏏 The Fantasy League

A self-contained fantasy game that lives in the **🏏 Fantasy** tab. It has its own data and
storage and does **not** touch the auction. **Every signed-in member picks their own team** -
admins, moderators and viewers alike.

### Concepts

- **Teams** and **Players** (each player belongs to a team).
- **Matches** - one fixture: two teams, a squad size, an optional per-team cap and a
  **closing time**. Stored in the `days` collection (the name predates the feature).
- **Entries** - one member's fantasy team for one match, stored as its own document at
  `fantasyEntries/{tid}/days/{dayId}/entries/{entryId}`.
- **Contestants** - *legacy only*. Older match days recorded participants by name; new
  matches use each member's own account.

### 🏏 Matches - how a round works

1. **An editor creates the match** (＋ Create match): Team A vs Team B, players per fantasy
   team, an optional *max from one team*, and the time entries close.
2. **Everyone picks a team** before that deadline: tap players from either squad, tap the
   Captain / Vice-captain slots to assign the multipliers, submit. The team can be edited
   as often as you like until the deadline.
3. **Entries close.** After `lockAt` nobody may submit, edit or delete a team - **moderators
   and admins included**. That is enforced by the security rules, not by the UI. To reopen,
   an editor pushes the closing time forward, which reopens the match for everyone equally.
4. **An editor enters the scores** (📝 Scores) - each player's runs and wickets - then
   presses **Publish points**. *Save scores* alone changes nothing anyone else can see;
   publishing is what puts the match on the leaderboard.

Until the deadline you can only see **your own** team; everyone else's appears the moment
entries close, so nobody can copy a squad at the last minute. Editors always see everything,
and can add a **guest team** for a participant who has no account (subject to the same
deadline).

### Scoring

```
player points  = runs + (wickets × 10)
captain        = player points × 2
vice-captain   = player points × 1.5
entry points   = sum of the entry's player points (with C/VC multipliers)
```

- **Match Standings** rank that match's teams by points (🥇🥈🥉).
- **Leaderboards (🏆)**:
  - **Contestants** - everyone ranked by **total** points across every published match.
  - **Player of the Season (⭐)** - top players by total fantasy points (raw performance;
    C/VC multipliers belong to an entry, not to a player).
  - Totals are shown in **yellow**; ranking is by total.

Publishing writes a denormalised `standings` array onto the match document, so the season
leaderboard is built from the `days` collection alone - it needs no extra listeners and no
access to entries that are still hidden. Matches from before this feature keep their inline
`entries[]` and keep counting, unchanged.

> ⚠️ **Adding a field to a match document?** `syncDiff()` writes a *whole-document replace*
> built from what `normDay()` knows about, so any field `normDay` doesn't list is deleted
> from Firestore the next time an editor touches that match. Add it to `normDay()` in
> `js/fantasy.js` first.

### Publishing the rules (required)

This feature does not work until `firestore.rules` is published - viewers get
`permission-denied` when they submit. Before publishing, run these in
**Firebase console → Firestore → Rules → Playground**:

| Auth | Op | State / payload | Expect |
|---|---|---|---|
| viewer `U` | create `fantasyEntries/hccl-s6/days/D/entries/U` | valid, lock in future | ✅ |
| viewer `U` | create `…/entries/V` | valid | ❌ |
| viewer `U` | update `…/entries/U` | wrong number of `playerIds` | ❌ |
| viewer `U` | update `…/entries/U` | one player listed twice | ❌ |
| viewer `U` | update `…/entries/U` | C == VC, or C not in `playerIds` | ❌ |
| viewer `U` | update `…/entries/U` | extra field, e.g. `points: 999` | ❌ |
| viewer `U` | update `…/entries/U` | `uid` set to someone else | ❌ |
| viewer `U` | update `…/entries/U` | lock in the past | ❌ |
| viewer `U` | update `…/entries/U` | match has `hasResults: true` | ❌ |
| **moderator** | create `…/entries/g_abc` | **lock in the past** | **❌** |
| moderator | create `…/entries/g_abc` | lock in future, `uid: ""` | ✅ |
| moderator | create `…/entries/V` | `uid: ""` (uid-squat) | ❌ |
| viewer | `list` entries | match still open | ❌ |
| viewer | `list` entries | match closed | ✅ |
| viewer `U` | `get …/entries/U` | match still open | ✅ |
| signed-out | `get …/entries/U` | — | ❌ |

Repeat the first few against `fantasyEntries/<other-tid>/…` to exercise the non-legacy
branch, then spot-check as a viewer that `auction/league/players/X`, `matches/X`, `mvp/X`,
`tournaments/T/stats/sheet` and `ranking/league` still read.

### 📷 Share as image

Both leaderboards and the Day Standings card have a **📷 Share** button that renders a
branded, dark-themed **PNG** (1080px wide, league title + subheading + date + medal
badges + the *HC Champions League* footer) and downloads it - ready to post in a group
chat. Built with the `html-to-image` library (loaded from a CDN).

---

## 📈 Player Ranking

A dedicated **Player Ranking** tab with three boards on one page - **Batting**,
**Bowling** and **All-Rounder** - each a Pos / Player Name / Team / Rating table (top 10,
expandable). Ratings are computed by `ranking-engine.js` from the bundled stats sheet
(`ranking-data.js`).

**Cloud-backed (seed once, read-only):** the computed boards are stored in Firestore at
`ranking/league`. Everyone signed in reads that doc; the first **admin/moderator** whose
bundled `HCCL_STATS_VERSION` is newer than the stored doc **auto-publishes** the boards
(no upload UI). Viewers never write (Firestore rules). If Firestore is unreachable, the
boards fall back to the local compute. To refresh: regenerate `ranking-data.js`, bump
`HCCL_STATS_VERSION`, redeploy - the next editor load re-seeds the cloud doc.

---

## 🏅 Season MVP

A dedicated **MVP** tab with two live boards:

- **Season MVP** - every player ranked by the sum of their Final Match MVP scores, with
  matches played and an efficiency (MVP ÷ matches) column.
- **Match-wise MVP** - pick a match from the chips to see that game's per-player breakdown
  (**Fixed** / **Impact** / **Final**), plus the scoreline, result and Player of the Match.

**How scores are calculated** - a hybrid model (`mvp-engine.js`, all constants in one
`CONFIG` block):

- **Fixed Points (70%)** - banded points for runs, strike rate, wickets, economy, dot balls
  and maidens, plus bonuses (not-out, top scorer, best figures, winning team +5, POTM +15).
- **Contribution Impact (30%)** - how much the player carried their team, each term as a
  **percentage number** (ratio × 100): batting share `runs ÷ team total × 100`, bowling share
  `wickets ÷ opposition wickets × 100`, and match result `100` if the team won else `0` -
  weighted `0.45 × batting + 0.45 × bowling + 0.10 × result`.
- **Final Match MVP** = `0.70 × Fixed + 0.30 × Impact`; **Season MVP** = Σ Final across matches;
  **Efficiency** = Season ÷ matches played.
- **Edge rules:** a player who didn't bat (0 balls) scores 0 on batting, and one who didn't
  bowl (0 overs) scores 0 on bowling; the +5 team-win bonus still goes to every winning-team
  player. The full method is documented in the locked comment block atop `js/mvp-engine.js`.

**Uploading matches (admin / moderator):** the **⬆ Upload match PDF** button reads an
exported **STUMPS "Match Report"** PDF entirely in the browser (`pdf.js`), extracts the two
innings scorecards + result + POTM, and stores the **parsed** match at `mvp/{matchId}` in
Firestore. Everyone signed in reads those docs and the boards are computed **client-side**,
so tuning the model + redeploy updates every score without re-uploading. Editors can delete
a match from its card. Realtime via `onSnapshot` (like fantasy).

> Players are identified by the **name shown in the PDF** (STUMPS nicknames like "Sasi18").
> To display roster names instead, add entries to `CONFIG.aliases` in `mvp-engine.js`
> (e.g. `"Sasi18": "SASINDU MADUSHAN"`) - they aggregate correctly across matches either way.

---

## ☁️ Cloud sync (how live mode works)

When Firebase is configured and you're signed in, the app switches from local storage to
**Firestore** as the source of truth:

```
fantasy/league/{teams, players, contestants, days}/{id}     ← fantasy league + matches
fantasyEntries/{tid}/days/{dayId}/entries/{entryId}         ← each member's own team
auction/league/{teams, players}/{id}                        ← auction text data
auction/league/state/{settings, live}                       ← settings + live auction state
auction/league/playerPhotos/{playerId}   { data: <base64> } ← one image per doc
auction/league/teamLogos/{teamId}        { data: <base64> } ← one image per doc
```

- `onSnapshot` listeners mirror server state into the app **in real time**; local edits are
  pushed back as a **minimal diff** (only changed/added/removed docs, in small batches).
- **Fantasy entries deliberately sit outside `fantasy/` and `tournaments/`.** Both of those
  roots are guarded by recursive `{document=**}` rules that grant read to any signed-in user
  and write to any editor; because Firestore ORs its rules, nothing nested under them can be
  made *stricter*. Entries need exactly that - hidden from rivals until the deadline, and
  frozen for moderators after it - so they get a root of their own. They are also written
  one document at a time, never batched, which keeps the parent-match `get()` in their rule
  inside the access-call budget.
- The auction is **presenter-driven** (last-write-wins): whoever is running it drives the
  state for everyone - it is deliberately *not* crowd-bidding.
- **Images live in their own one-image-per-document collections** (`playerPhotos`,
  `teamLogos`) so the heavy base64 blobs never bloat the frequently-synced player/team
  docs (which would otherwise hit Firestore's write-size limits and fail). Every signed-in
  viewer sees the same photos and logos.
- If the cloud is unreachable (offline, blocked, rules not published), the app **falls back
  to the local backup** and shows a "this device only" notice instead of getting stuck.

### Moving an existing local setup into the cloud

If you built teams/players on one device before turning on live mode, sign in there, open
**Setup → Data & Backup**, and click **☁ Upload local data to cloud** (this row appears
once live sync is active). It pushes this device's saved data - including photos and
logos - into the shared cloud. Other signed-in devices then receive everything live.

---

## 💾 Data, backup & reset

In **Setup → Data & Backup**:

- **⬇ Export backup** - downloads a `.json` of the whole auction. Keep it safe.
- **⬆ Import backup** - restore from a `.json` (e.g. onto another laptop).
- **Re-open unsold players** - puts unsold players back up for auction.
- **Reset auction results** - keeps teams/players but clears all sales and refills purses.
- **Erase everything** - wipes back to empty.

The fantasy module has its own export/import in the Fantasy tab.

> 💡 Even in cloud mode, your last local copy is preserved as a backup, and exporting JSON
> regularly is the safest habit.

---

## 🚀 Running it

**Open it directly** - double-click `index.html`. (With no Firebase config it runs as a
local single-device tool.)

**Run a tiny local server** (recommended; some browsers restrict storage on `file://`):

```bash
# Python
python -m http.server 8000
# then open http://localhost:8000
```

There is **nothing to install or build** - no `npm install`, no compile step.

---

## 🌐 Deployment

The site is a static bundle, deployed on **Vercel** at
https://hc-champions-league.vercel.app. Any static host works (Vercel, Netlify, GitHub
Pages, Firebase Hosting). `vercel.json` is included for optional auth-handler rewrites.

To deploy your own copy: push this folder to a static host and make sure
`firebase-config.js` points at your Firebase project.

---

## 🔥 Firebase setup

Live mode needs a Firebase project with **Authentication** and **Firestore**:

1. **Firestore Database** - create it (in production mode).
2. **Authentication** - enable the **Google** sign-in provider, and add your site's domain
   to the **Authorized domains** list. For OAuth, the redirect URI
   `https://<your-domain>/__/auth/handler` must be allowed.
3. **Security rules** - paste the contents of `firestore.rules` into
   *Firestore → Rules → Publish*. They enforce: signed-in to read, editors-only to write,
   admins-only to manage roles, and an owner-email bootstrap admin.
4. **Config** - put your project's public web config in `firebase-config.js`, and set the
   admin/owner email there and in `firestore.rules`.

> The values in `firebase-config.js` are **public client keys** (safe to commit) - access
> is protected by the Firestore security rules, not by hiding the config.

---

## 🎨 Branding a new season

- **In-app:** set the season name/number and upload the league logo in
  **Setup → League Settings**. This drives the header, the tab title, and the favicon.
- **Sign-in wall + default favicon:** swap the committed `assets/brand-logo.jpeg` (the league
  shield shown on the landing/sign-in screen and as the fallback tab icon) to rebrand for a
  new season.

---

## 📁 Project structure

Files are grouped into folders; `index.html`, `vercel.json`, `.gitignore`, and the
Firebase files stay in the root (Vercel serves `index.html` from the root, and paths in
the HTML/JS are relative to it).

| Path | Purpose |
|------|---------|
| `index.html` | Page structure (header, auction tabs, Insights view, fantasy mount, overlays) |
| `vercel.json` | Static host config / optional auth rewrites |
| `firebase-init.js` | Google auth, roles, members, split landing page, `window.HCCL` API |
| `firebase-config.js` | Public Firebase web config + admin email list |
| `firestore.rules` | Security rules (roles; `/auction` `/fantasy` `/ranking` `/home` `/mvp` `/liveMatches` read/write gating) |
| `js/app.js` | Auction logic, Squad Tracker/Safe Bid, Insights, season stats, Firestore sync |
| `js/fantasy-engine.js` | Fantasy scoring, lock state, squad validation, standings (pure, Node-testable) |
| `js/fantasy.js` | Fantasy league view + Firestore sync (Phase C) + self-serve entries |
| `js/home.js` | Home page: hero + past-seasons carousel + Firestore read/seed of `home/seasons` |
| `js/ranking.js` | Player Ranking boards UI + Firestore read/seed of `ranking/league` |
| `js/ranking-engine.js` | Rating math (batting/bowling/all-rounder) from the stats CSV |
| `js/ranking-data.js` | Bundled stats CSV + `HCCL_STATS_VERSION` (ranking source/fallback) |
| `js/mvp.js` | MVP boards UI + STUMPS PDF upload (pdf.js) + realtime `mvp/{matchId}` sync |
| `js/mvp-engine.js` | Hybrid MVP model: PDF-scorecard parser + scoring + season aggregation |
| `js/live-engine.js` | Hand-cricket scoring rules for Live Now (pure, Node-testable) |
| `js/live.js` | Live Now tab: lobby, scoreboard, wagon wheel, scorecards, scoring panel + `liveMatches` sync |
| `css/styles.css` | Theme + auction UI + Squad Tracker / insights / role gating |
| `css/fantasy.css` | Fantasy tab styling |
| `css/live.css` | Live Now styling (scoreboard, ground, tap pad, role gating) |
| `assets/brand-logo.jpeg` | League logo for the sign-in wall and default favicon |
| `docs/HCCL Player Stats/` | Raw stats exports (source for regenerating `js/ranking-data.js`) |
| `docs/HCCL Batting Rankings Explanation.pdf` | Reference doc for the batting rating math |

---

## 🛠 Tech notes

- **Vanilla JS, no build.** `app.js` and `fantasy.js` are classic scripts; `firebase-init.js`
  is an ES module loaded from the gstatic Firebase CDN (v10).
- **Two storage seams:** `hccl_auction_v1` (auction) and `hccl_fantasy_v1` (fantasy) in
  local storage; Firestore takes over transparently in cloud mode.
- **`window.HCCL`** is the bridge the auction/fantasy modules use for auth state, roles
  (`canEdit()`, `isAdmin()`), the `onChange` sign-in hook, and Firestore helpers.
- **Image sharing** uses `html-to-image`, **charts** use `Chart.js`, and **MVP PDF parsing**
  uses `pdf.js` - all from a CDN, no npm/build step.
- **Resilient by design:** every cloud path has a local-storage fallback, so a blocked or
  offline Firestore never bricks the app.

### Phase E schema additions (all optional, backwards compatible)
- **Player:** `stats { matches, runs, wickets, strikeRate, economy, average, fantasyPoints,
  previousPrice }`, and `soldBids` (bid count captured at sale, for "Biggest Bid War"). Both
  ride inside the existing player doc.
- The hard squad cap is **5 players** (`MAX_PLAYERS` in `app.js`).