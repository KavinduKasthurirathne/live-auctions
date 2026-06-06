# HCCL Live Auction

A simple, single-screen live auction tool for the **HCCL Champions League**.
Built with plain HTML/CSS/JavaScript — no installation, no internet, no accounts.
Everything is saved automatically in your browser.

---

## How to run

**Option A – just open it (easiest)**
Double-click **`index.html`**. It opens in your browser and works offline.

**Option B – run a tiny local server (most reliable for saving)**
Some browsers are stricter about saving data on `file://` pages. If you want to be
100% safe, open a terminal in this folder and run one of:

```powershell
# If you have Python:
python -m http.server 8000
# then open  http://localhost:8000
```

Either way, **export a backup regularly** (Setup → Data & Backup) so your auction
is never lost.

---

## First-time setup (do this before the auction)

Open the **⚙️ Setup** tab:

1. **League Settings** – set the season name/number (e.g. *HCCL Season 06*),
   currency label (default `Cr`), default purse per team, bid increment, and upload
   your league logo. Click **Save Settings**.
   *(The season number is changed here each season — that's the only thing you edit
   manually season-to-season.)*
2. **Add Team** – name + purse + logo for each team. Repeat for all teams.
3. **Add Player** – name, role, base price and photo for each player. They are
   auctioned **top-to-bottom** in this list — use ▲ ▼ to reorder.
4. **Retain / Pre-assign Player** (optional) – players a team keeps from last
   season. Pick the team; the price is optional (record only). They go straight
   into that team's squad (with a **RET** tag), are skipped by the auction, and
   survive a "Reset auction results". The retention price is **not** deducted —
   the purse you set is the fresh new-season budget, so only buying new players
   in the auction reduces it.

Want to try it first? Click **Load sample data**.

---

## Running the auction (🔨 Live Auction tab)

- The first player appears automatically with their **photo, name and base price**.
- Each **team has a bid button**. The first click bids the **base price**; every click
  after that raises the bid by your increment (1 → 2 → 3 …). The bid is tagged with
  that team's name. The leading team is highlighted green and can't out-bid itself.
- Teams that can't afford the next bid are automatically disabled.
- **SOLD button** steps through **GOING ONCE → GOING TWICE → GOING THRICE → SELL**.
  A new bid during the countdown resets it.
- When finalized, the screen shows **"{Player} SOLD to {Team} for {Price}"**, the
  team's purse drops, and their squad updates.
- **Unsold** marks a player unsold (use when there are no bids).
- **Next Player ▶** brings the next player automatically.
- **↩ Undo** reverts the last sold/unsold result (great for mistakes).
- **⟳ Reset Bid** clears the current player's bids and starts them over.

### Keyboard shortcuts (auction tab)
| Key | Action |
|-----|--------|
| `1`–`9` | Bid for team 1–9 |
| `Space` | Advance SOLD (once/twice/thrice/sell) |
| `U` | Unsold |
| `N` | Next player |
| `Z` | Undo |
| `Enter` | Next player (on the result screen) |

---

## The other tabs

- **👥 Players** – every player with base price and status (Available / Sold / Unsold),
  sale price and buying team. Search and filter. You can also "Auction now" any player
  out of order, or "Re-auction" an unsold one.
- **💰 Teams & Purse** – each team's total, spent and **remaining purse** (updates live
  as players sell).
- **🏆 Squads** – each team's logo, name and the players they've bought with prices.

---

## Backup & reset (Setup → Data & Backup)

- **Export backup** – downloads a `.json` file with the whole auction. Keep this safe.
- **Import backup** – restore from a `.json` file (e.g. on another laptop).
- **Re-open unsold players** – puts unsold players back up for auction.
- **Reset auction results** – keeps teams/players but clears all sales and refills purses.
- **Erase everything** – wipes all data back to empty.

> **Note on the logo:** the image shared in chat looked like a screenshot rather than a
> logo file, so the league logo is left blank. Upload the real HCCL logo in
> **Setup → League Settings** and it appears in the header and on the SOLD screen.

---

## Files
| File | Purpose |
|------|---------|
| `index.html` | Page structure |
| `styles.css` | Dark red/yellow/black theme |
| `app.js` | All auction logic & storage |
