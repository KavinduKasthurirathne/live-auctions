# 🏏 HCCL — Hand Cricket Champions League

A single-page web app for running a **live cricket player auction** *and* a **fantasy
league** for the Hand Cricket Champions League (HCCL). It's built with plain
HTML/CSS/JavaScript — **no build step, no framework, no bundler**. Open it and it runs.

Two ways to run, automatically chosen:

- **☁️ Live multi-device mode** — when Firebase is configured, everyone signs in with
  Google and sees the **same auction and fantasy data in real time** across phones and
  laptops. Roles control who can edit.
- **💾 Single-device mode** — with no Firebase (or if the cloud is unreachable), the app
  quietly falls back to saving everything in the browser's local storage, exactly as a
  standalone tool. Nothing is lost.

🔗 **Live site:** https://live-auctions-hazel.vercel.app

---

## Table of contents

- [Highlights](#highlights)
- [Sign-in & roles](#sign-in--roles)
- [The Auction](#-the-auction)
- [The Fantasy League](#-the-fantasy-league)
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
- 📋 **Live Squad Tracker + Safe Bid** — every team's slots, purse and budget health at a
  glance; bids are capped so no team can spend itself out of completing a 5-player squad.
- 🏑 **Captains raise the paddle from their phones** — transaction-safe live bidding, with an
  animated raise feed on the presenter screen.
- 📊 **Auction Insights tab** — live analytics, top-buys/role-spend/team tables, and Chart.js
  visualisations, all derived client-side (no extra reads).
- 📈 **Optional player season stats** shown on the block; ✨ confetti, glow and pulse polish;
  ⛶ presenter fullscreen.
- 🏏 **Fantasy league** with match days, captain/vice-captain multipliers, live points,
  season leaderboards and a Player of the Season board.
- ☁️ **Real-time sync** via Firestore — auction and fantasy state mirror instantly to
  every signed-in device.
- 🔐 **Google sign-in with Admin / Moderator / Captain / Viewer roles** and a members screen.
- 🖼️ **Player photos & team logos in the cloud**, stored so every viewer sees them.
- 📷 **Share leaderboards as branded PNG images** (one-tap download).
- 💾 **Export / import JSON backups** any time, and a graceful offline fallback.
- 🎨 Dark **red / yellow / black** theme, custom league logo, favicon and tab title.

---

## Sign-in & roles

When Firebase is configured, the app shows a **sign-in wall** — you must sign in with
Google before you can see anything. Each user has one of three roles:

| Role | Can do |
|------|--------|
| **Admin** | Everything: run the auction, edit fantasy, **and manage members/roles**. |
| **Moderator** | Create / update / delete auction **and** fantasy data. No role management. |
| **Captain** | Read-only **except** they may **raise bids** for their one assigned team (the Raise Paddle) and view all insights. No selling, setup, or editing. |
| **Viewer** | Read-only. Sees the auction, squads, fantasy and leaderboards — no edit controls, no setup pages. |

> Captains are assigned a single team by an admin in the **👤 Members** screen. The
> hierarchy is **admin ▸ moderator ▸ captain ▸ viewer**.

- The **owner email** (configured in `firestore.rules` and `firebase-config.js`) is always
  treated as an admin, even before any profile exists — it bootstraps the system.
- New users default to **Viewer**. An admin promotes them from the **👤 Members** screen
  (open it from the header chip after signing in).
- The UI gates itself by role: viewers never see edit buttons, the Setup tab, or keyboard
  auction shortcuts.

---

## 🔨 The Auction

### First-time setup (⚙️ Setup tab)

1. **League Settings** — season name & number (e.g. *HCCL Season 06*), currency label
   (default `Cr`), default purse per team, bid increment, and the league logo. The season
   name + number also become the **browser tab title**, and the logo becomes the
   **favicon**.
2. **Add Team** — name, purse (blank = default) and logo for each team.
3. **Add Player** — name, role/category, base price and photo. Players are auctioned
   **top-to-bottom** in this list; reorder with ▲ ▼.
4. **Retain / Pre-assign Player** *(optional)* — players a team keeps from last season.
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

- **👥 Players** — every player with base price and status (Available / Sold / Unsold),
  sale price and buying team. Search & filter; auction any player out of order, or
  re-auction an unsold one.
- **💰 Teams & Purse** — each team's total, spent and **remaining purse**, live.
- **🏆 Squads** — each team's logo, name and the players they bought, with prices.

### Auction intelligence & captains (Phase E)

- **📋 Live Squad Tracker** — a card per team in the Live Auction (visible to everyone):
  player dots, `x / 5` slots, remaining purse, **Safe Bid**, average spend, and a
  green/yellow/red budget-health bar.
- **Safe Bid & smart restrictions** — every team must finish with **5 players**, so the app
  reserves enough purse to fill empty slots and **disables bids above the Safe Bid**
  (`safeBid = remainingPurse − max(0, slotsLeft−1) × cheapestAvailableBase`). A team that's
  full (5 players) can't bid. This applies to the presenter and to captains alike.
- **🏑 Captains & Raise Paddle** — an admin gives a member the **captain** role and a team in
  **👤 Members**. That captain signs in on their own phone and sees a single big **RAISE
  PADDLE** dashboard (team name, purse, slots, Safe Bid). Tapping it raises the live bid.
  Bids commit through a **Firestore transaction**, so simultaneous taps never drop or double a
  bid, and the presenter screen shows an animated `🔥 raised paddle` feed. The auctioneer
  still controls SOLD / Unsold / Undo / Next.
- **📊 Insights tab** — live, read-only analytics derived entirely from local state: most
  expensive / cheapest / averages, sold-vs-unsold, completion %, money spent/remaining,
  biggest bid war, per-team and per-role spending tables, plus Chart.js charts (price
  histogram, sold/unsold, role and team spending, remaining purse). Charts degrade gracefully
  if the Chart.js CDN is blocked — the numbers and tables still render.
- **📈 Season stats** — players can carry optional historical stats (matches, runs, wickets,
  strike rate, economy, average, fantasy points, previous price), entered in the player form
  under *Season stats (optional)* and shown as a card under the photo during the auction.
- **✨ Polish** — a confetti burst at auction completion, plus glow and pulse animations and an
  optional **⛶ Fullscreen** presenter mode.

---

## 🏏 The Fantasy League

A self-contained fantasy game that lives in the **🏏 Fantasy** tab. It has its own data and
storage and does **not** touch the auction.

### Concepts

- **Teams** and **Players** (each player belongs to a team).
- **Contestants** — the people playing fantasy (your friends/participants).
- **Match Days** — each day picks which teams are playing, records every player's
  performance, and holds each contestant's **entry** (their picked squad).

### Match Day (📅) — build entries & enter results

- Create a day (date + optional label) and choose which **teams** play that day.
- Each **contestant's entry** picks players from that day's pool and designates a
  **Captain (C)** and **Vice-Captain (VC)**.
- Enter each player's **runs** and **wickets**; points compute live.

### Scoring

```
player points  = runs + (wickets × 10)
captain        = player points × 2
vice-captain   = player points × 1.5
entry points   = sum of the entry's player points (with C/VC multipliers)
```

- **Day Standings** rank that day's entries by points (🥇🥈🥉).
- **Leaderboards (🏆)**:
  - **Contestants** — every contestant ranked by **total** points across all days that
    have results.
  - **Player of the Season (⭐)** — top players ranked by total fantasy points.
  - Totals are shown in **yellow**; ranking is by total.

### 📷 Share as image

Both leaderboards and the Day Standings card have a **📷 Share** button that renders a
branded, dark-themed **PNG** (1080px wide, league title + subheading + date + medal
badges + the *HC Champions League* footer) and downloads it — ready to post in a group
chat. Built with the `html-to-image` library (loaded from a CDN).

---

## ☁️ Cloud sync (how live mode works)

When Firebase is configured and you're signed in, the app switches from local storage to
**Firestore** as the source of truth:

```
fantasy/league/{teams, players, contestants, days}/{id}     ← fantasy data
auction/league/{teams, players}/{id}                        ← auction text data
auction/league/state/{settings, live}                       ← settings + live auction state
auction/league/playerPhotos/{playerId}   { data: <base64> } ← one image per doc
auction/league/teamLogos/{teamId}        { data: <base64> } ← one image per doc
```

- `onSnapshot` listeners mirror server state into the app **in real time**; local edits are
  pushed back as a **minimal diff** (only changed/added/removed docs, in small batches).
- The auction is **presenter-driven** (last-write-wins): whoever is running it drives the
  state for everyone — it is deliberately *not* crowd-bidding.
- **Images live in their own one-image-per-document collections** (`playerPhotos`,
  `teamLogos`) so the heavy base64 blobs never bloat the frequently-synced player/team
  docs (which would otherwise hit Firestore's write-size limits and fail). Every signed-in
  viewer sees the same photos and logos.
- If the cloud is unreachable (offline, blocked, rules not published), the app **falls back
  to the local backup** and shows a "this device only" notice instead of getting stuck.

### Moving an existing local setup into the cloud

If you built teams/players on one device before turning on live mode, sign in there, open
**Setup → Data & Backup**, and click **☁ Upload local data to cloud** (this row appears
once live sync is active). It pushes this device's saved data — including photos and
logos — into the shared cloud. Other signed-in devices then receive everything live.

---

## 💾 Data, backup & reset

In **Setup → Data & Backup**:

- **⬇ Export backup** — downloads a `.json` of the whole auction. Keep it safe.
- **⬆ Import backup** — restore from a `.json` (e.g. onto another laptop).
- **Re-open unsold players** — puts unsold players back up for auction.
- **Reset auction results** — keeps teams/players but clears all sales and refills purses.
- **Erase everything** — wipes back to empty.

The fantasy module has its own export/import in the Fantasy tab.

> 💡 Even in cloud mode, your last local copy is preserved as a backup, and exporting JSON
> regularly is the safest habit.

---

## 🚀 Running it

**Open it directly** — double-click `index.html`. (With no Firebase config it runs as a
local single-device tool.)

**Run a tiny local server** (recommended; some browsers restrict storage on `file://`):

```bash
# Python
python -m http.server 8000
# then open http://localhost:8000
```

There is **nothing to install or build** — no `npm install`, no compile step.

---

## 🌐 Deployment

The site is a static bundle, deployed on **Vercel** at
https://live-auctions-hazel.vercel.app. Any static host works (Vercel, Netlify, GitHub
Pages, Firebase Hosting). `vercel.json` is included for optional auth-handler rewrites.

To deploy your own copy: push this folder to a static host and make sure
`firebase-config.js` points at your Firebase project.

---

## 🔥 Firebase setup

Live mode needs a Firebase project with **Authentication** and **Firestore**:

1. **Firestore Database** — create it (in production mode).
2. **Authentication** — enable the **Google** sign-in provider, and add your site's domain
   to the **Authorized domains** list. For OAuth, the redirect URI
   `https://<your-domain>/__/auth/handler` must be allowed.
3. **Security rules** — paste the contents of `firestore.rules` into
   *Firestore → Rules → Publish*. They enforce: signed-in to read, editors-only to write,
   admins-only to manage roles, and an owner-email bootstrap admin.
4. **Config** — put your project's public web config in `firebase-config.js`, and set the
   admin/owner email there and in `firestore.rules`.

> The values in `firebase-config.js` are **public client keys** (safe to commit) — access
> is protected by the Firestore security rules, not by hiding the config.

---

## 🎨 Branding a new season

- **In-app:** set the season name/number and upload the league logo in
  **Setup → League Settings**. This drives the header, the tab title, and the favicon.
- **Sign-in wall + default favicon:** swap the committed `brand-logo.jpg` (the league
  shield shown on the landing/sign-in screen and as the fallback tab icon) to rebrand for a
  new season.

---

## 📁 Project structure

| File | Purpose |
|------|---------|
| `index.html` | Page structure (header, auction tabs, Insights view, fantasy mount, overlays) |
| `app.js` | Auction logic, Squad Tracker/Safe Bid, captain paddle + bid transaction, Insights, season stats, confetti, Firestore sync |
| `fantasy.js` | Self-contained fantasy league module + Firestore sync (Phase C) |
| `firebase-init.js` | Google auth, roles (incl. captain + team), members screen, sign-in wall, `window.HCCL` API |
| `firebase-config.js` | Public Firebase web config + admin email list |
| `firestore.rules` | Security rules (roles, read/write gating, captain live-bid rule) |
| `styles.css` | Theme + auction UI + Squad Tracker / captain / insights / role gating |
| `fantasy.css` | Fantasy tab styling |
| `brand-logo.jpg` | League logo for the sign-in wall and default favicon |
| `vercel.json` | Static host config / optional auth rewrites |

---

## 🛠 Tech notes

- **Vanilla JS, no build.** `app.js` and `fantasy.js` are classic scripts; `firebase-init.js`
  is an ES module loaded from the gstatic Firebase CDN (v10).
- **Two storage seams:** `hccl_auction_v1` (auction) and `hccl_fantasy_v1` (fantasy) in
  local storage; Firestore takes over transparently in cloud mode.
- **`window.HCCL`** is the bridge the auction/fantasy modules use for auth state, roles
  (`canEdit()`, `isAdmin()`, `isCaptain()`, `canBid()`, `teamId`), the `onChange` sign-in
  hook, and Firestore helpers (incl. `runTransaction`).
- **Image sharing** uses `html-to-image` and **charts** use `Chart.js` — both from a CDN, no
  npm/build step.
- **Captain bids** are the only multi-writer path, so each one commits via a Firestore
  **transaction** on `auction/league/state/live`; a dedicated rule lets captains write **only**
  that doc.
- **Resilient by design:** every cloud path has a local-storage fallback, so a blocked or
  offline Firestore never bricks the app.

### Phase E schema additions (all optional, backwards compatible)
- **Player:** `stats { matches, runs, wickets, strikeRate, economy, average, fantasyPoints,
  previousPrice }`, and `soldBids` (bid count captured at sale, for "Biggest Bid War"). Both
  ride inside the existing player doc.
- **User profile:** `teamId` — the single team a captain bids for (set by an admin).
- **Bid-log entries:** `by` (`"presenter"` | `"captain"`) — marks who raised each bid.
- **New role** `captain`; the hard squad cap is **5 players** (`MAX_PLAYERS` in `app.js`).