/* ============================================================
   HCCL Fixtures & Results  (renders into #view-fixtures)

   The league's match centre:
     • Upcoming Fixtures  - scheduled / live / postponed matches
     • Recent Results     - completed matches, newest first
     • Standings          - built from completed matches (fixtures-engine.js)
     • Match details      - scorecard, batting & bowling cards, notes

   Admins / moderators additionally get:
     • "＋ Create Match"        - teams, date/time, venue, format, status,
                                  toss, notes. Picking the teams pulls each
                                  squad straight from the auction data.
     • "⬆ Import Stumps Report" - reads the STUMPS match-report PDF in the
                                  browser (pdf.js, shared with the MVP tab),
                                  shows every extracted value in an editable
                                  confirm dialog, then completes the match.
     • Publish / unpublish, edit, delete.

   Storage mirrors the rest of the app: Firestore `matches/{id}` in live mode
   (realtime for everyone), localStorage otherwise - so the tab works signed
   out / offline exactly like the auction does.
   ============================================================ */
(function () {
  "use strict";

  const LS_KEY = "hccl_matches_v1";

  let matches = [];            // all match docs
  let cloud = false;           // Firestore-backed?
  let syncStarted = false;
  let busy = false;            // a PDF import is being processed
  let modal = null;            // { type: "form"|"detail"|"import", ... }

  const eng = () => window.HCCLFixtures;
  const mvp = () => window.HCCLMvp;
  const auction = () => window.HCCLAuction;

  /* ---------------------------- helpers ---------------------------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function toast(m, k) { if (typeof window.toast === "function") window.toast(m, k); else console.log("[Fixtures]", m); }
  function canEdit() {
    const H = window.HCCL;
    return !H || !H.configured || !!(H.user && H.canEdit && H.canEdit());
  }
  const uid = () => "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const teams = () => (auction() ? auction().teams() : []);
  const teamById = id => teams().find(t => t.id === id) || null;
  const teamName = id => { const t = teamById(id); return t ? t.name : "TBD"; };

  function teamLogoHtml(id, cls) {
    const t = teamById(id);
    const name = t ? t.name : "?";
    const initials = name.trim().split(/\s+/).slice(0, 2).map(w => w[0] || "").join("").toUpperCase();
    const style = t && t.logo ? `style="background-image:url('${t.logo}')"` : "";
    return `<span class="${cls}" ${style} title="${esc(name)}">${t && t.logo ? "" : esc(initials || "?")}</span>`;
  }

  function fmtDate(ms) {
    if (!ms) return "Date TBD";
    const d = new Date(ms);
    if (isNaN(d)) return "Date TBD";
    return d.toLocaleString(undefined, {
      weekday: "short", day: "numeric", month: "short",
      hour: "2-digit", minute: "2-digit",
    });
  }
  // <input type="datetime-local"> wants local-time "YYYY-MM-DDTHH:mm".
  function toLocalInput(ms) {
    if (!ms) return "";
    const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
    return isNaN(d) ? "" : d.toISOString().slice(0, 16);
  }
  const fromLocalInput = v => { const t = Date.parse(v); return isFinite(t) ? t : 0; };

  const isDone = m => m.status === "completed";
  const visible = m => m.published !== false || canEdit();   // drafts: editors only
  const sortUpcoming = (a, b) => (a.scheduledAt || Infinity) - (b.scheduledAt || Infinity);
  const sortRecent = (a, b) => (b.scheduledAt || 0) - (a.scheduledAt || 0);

  /* --------------------------- storage ----------------------------- */
  // Cloud (Firestore) when signed in and configured; localStorage otherwise.
  function loadLocal() {
    try { const raw = localStorage.getItem(LS_KEY); matches = raw ? JSON.parse(raw) : []; }
    catch (e) { matches = []; }
    if (!Array.isArray(matches)) matches = [];
  }
  function saveLocal() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(matches)); }
    catch (e) { toast("Storage full - export a backup", "bad"); }
  }

  function startSync() {
    const H = window.HCCL;
    if (syncStarted || !H || !H.configured || !H.user || !H.db || !H.fs) return;
    const fs = H.fs;
    if (!fs.collection || !fs.onSnapshot) return;
    syncStarted = true; cloud = true;
    fs.onSnapshot(fs.collection(H.db, "matches"), snap => {
      const docs = [];
      snap.forEach(d => docs.push({ id: d.id, ...d.data() }));
      matches = docs;
      render();
    }, err => {
      console.error("matches snapshot error:", err);
      cloud = false; syncStarted = false;
      loadLocal();
      toast("Match sync unavailable - this device only", "bad");
      render();
    });
  }

  async function putMatch(m) {
    m.updatedAt = Date.now();
    if (cloud) {
      const H = window.HCCL, fs = H.fs;
      const data = { ...m }; delete data.id;
      data.updatedBy = H.user ? (H.user.email || H.user.uid || "") : "";
      await fs.setDoc(fs.doc(H.db, "matches", m.id), data);
    } else {
      const i = matches.findIndex(x => x.id === m.id);
      if (i >= 0) matches[i] = m; else matches.push(m);
      saveLocal(); render();
    }
  }
  async function removeMatch(id) {
    if (cloud) {
      const H = window.HCCL;
      await H.fs.deleteDoc(H.fs.doc(H.db, "matches", id));
    } else {
      matches = matches.filter(m => m.id !== id);
      saveLocal(); render();
    }
  }

  /* ------------------------- match factory -------------------------- */
  function blankMatch() {
    return {
      id: uid(),
      homeTeamId: "", awayTeamId: "",
      scheduledAt: 0, venue: "", format: "Last Man Stands",
      stage: eng() ? eng().DEFAULT_STAGE : "group",
      status: "scheduled", toss: "", notes: "",
      homeSquad: [], awaySquad: [],
      published: true,
      importedReportUrl: "",   // reserved: set when a report is hosted in Storage
      importedReport: null,    // { name, size, importedAt, importedBy }
      resultData: null,        // { resultType, winnerTeamId, margin, home, away, summary, potm }
      scorecardData: null,     // { teams:[…], players:[…] } - HCCLMvp parse shape
      createdAt: Date.now(), updatedAt: Date.now(),
    };
  }
  // Squads come from the auction data, snapshotted onto the match so the line-ups
  // stay stable even if a player is later re-auctioned.
  function squadOf(teamId) { return teamId && auction() ? auction().squad(teamId) : []; }

  /* ========================== RENDER: cards ========================== */
  function statusChip(m) {
    const label = (eng() && eng().STATUS_LABEL[m.status]) || m.status;
    return `<span class="fx-chip fx-st-${esc(m.status)}">${m.status === "live" ? "🔴 " : ""}${esc(label)}</span>`;
  }
  function draftChip(m) {
    return m.published === false ? `<span class="fx-chip fx-draft">Draft</span>` : "";
  }
  // Playoff matches are visually distinct - they don't feed the points table.
  function stageChip(m) {
    const s = eng().stageMeta(eng().stageOf(m));
    const knock = !s.table;
    return `<span class="fx-chip fx-stage${knock ? " fx-knockout" : ""}"
      title="${knock ? "Knockout - does not count towards the standings" : "Group stage - counts towards the standings"}">${knock ? "🏆 " : ""}${esc(s.label)}</span>`;
  }

  function scoreLine(m, side) {
    const rd = m.resultData;
    if (!rd) return "";
    const s = side === "home" ? rd.home : rd.away;
    if (!s) return "";
    const ov = s.balls ? ` <span class="fx-ov">(${eng().ballsToOvers(s.balls)} ov)</span>` : "";
    return `<span class="fx-score">${esc(String(s.runs))}/${esc(String(s.wickets))}${ov}</span>`;
  }

  function matchCard(m) {
    const rd = m.resultData;
    // Effective winner: the Super Over winner if the match was tied and went to one.
    const winnerId = rd ? eng().effectiveWinnerId(m) : "";
    const hw = winnerId && winnerId === m.homeTeamId ? " fx-won" : "";
    const aw = winnerId && winnerId === m.awayTeamId ? " fx-won" : "";
    const so = eng().hasSuperOver(m) ? `<span class="fx-chip fx-so">⚡ Super Over</span>` : "";
    const summary = rd && rd.summary
      ? `<div class="fx-summary">🏆 ${esc(rd.summary)}</div>`
      : isDone(m) ? "" : `<div class="fx-pending">Result pending</div>`;
    const meta = [
      m.venue ? `📍 ${esc(m.venue)}` : "",
      m.format ? `🏏 ${esc(m.format)}` : "",
    ].filter(Boolean).join(" · ");

    const admin = canEdit() ? `<div class="fx-card-actions">
        <button class="btn btn-dark btn-mini" data-fx-import="${esc(m.id)}">⬆ Import Stumps Report</button>
        <button class="btn btn-dark btn-mini" data-fx-edit="${esc(m.id)}">✎ Edit</button>
        <button class="btn btn-dark btn-mini" data-fx-publish="${esc(m.id)}">${m.published === false ? "👁 Publish" : "🚫 Unpublish"}</button>
        <button class="btn btn-danger btn-mini" data-fx-del="${esc(m.id)}">🗑 Delete</button>
      </div>` : "";

    return `<article class="fx-card" data-fx-open="${esc(m.id)}" tabindex="0" role="button" aria-label="Open match details">
      <header class="fx-card-head">
        <div class="fx-chips">${stageChip(m)}${statusChip(m)}${so}${draftChip(m)}</div>
        <time class="fx-when">${esc(fmtDate(m.scheduledAt))}</time>
      </header>
      <div class="fx-teams">
        <div class="fx-team${hw}">
          ${teamLogoHtml(m.homeTeamId, "fx-logo")}
          <span class="fx-tname">${esc(teamName(m.homeTeamId))}</span>
          ${scoreLine(m, "home")}
        </div>
        <span class="fx-vs">vs</span>
        <div class="fx-team${aw}">
          ${teamLogoHtml(m.awayTeamId, "fx-logo")}
          <span class="fx-tname">${esc(teamName(m.awayTeamId))}</span>
          ${scoreLine(m, "away")}
        </div>
      </div>
      ${summary}
      ${meta ? `<div class="fx-meta">${meta}</div>` : ""}
      ${admin}
    </article>`;
  }

  function emptyState(title, sub) {
    return `<div class="fx-empty"><h3>${esc(title)}</h3><p>${esc(sub)}</p></div>`;
  }

  /* ========================== RENDER: standings ====================== */
  // "2 Points" / "1 Point" - read from CONFIG.points so the key under the table
  // can never disagree with how the table is actually scored.
  const pts = n => `${n} Point${n === 1 ? "" : "s"}`;

  function standingsTable() {
    const ts = teams();
    if (!ts.length) return emptyState("No teams yet", "Add teams in the ⚙️ Setup tab to build the standings.");
    const mine = matches.filter(visible);
    const rows = eng().standings(mine, ts);
    const anyPlayed = rows.some(r => r.played > 0);
    if (!anyPlayed) {
      // Distinguish "nothing played" from "only playoffs played" - otherwise an
      // admin who imported a Final would think the table was broken.
      const onlyKnockouts = mine.some(m => m.status === "completed" && m.resultData)
        && !mine.some(m => m.status === "completed" && m.resultData && eng().countsForStandings(m));
      return emptyState("No standings yet", onlyKnockouts
        ? "Only knockout matches are completed so far  the table is built from group-stage results."
        : "The table fills up as soon as the first group-stage match is completed.");
    }
    const p = eng().CONFIG.points;
    // Playoff cut-off: a yellow line under the last qualifying team. Only drawn
    // when some team actually sits below it - otherwise it's a line under nothing.
    const cutoff = eng().CONFIG.playoffCutoff;
    const showCutoff = rows.length > cutoff;
    const body = rows.map(r => `<tr${showCutoff && r.pos === cutoff ? ` class="fx-cutoff"` : ""}>
      <td class="fx-pos">${r.pos}</td>
      <td class="fx-stname">${teamLogoHtml(r.teamId, "fx-logo sm")}<span>${esc(r.name)}</span></td>
      <td>${r.played}</td>
      <td>${r.wins}</td>
      <td>${r.losses}</td>
      <td>${r.ties}</td>
      <td class="fx-pts">${r.points}</td>
      <td class="${r.nrr == null ? "fx-dim" : r.nrr >= 0 ? "fx-pos-nrr" : "fx-neg-nrr"}">${r.nrr == null ? "–" : (r.nrr > 0 ? "+" : "") + r.nrr.toFixed(2)}</td>
    </tr>`).join("");
    return `<div class="fx-table-wrap">
      <table class="fx-table">
        <thead><tr>
          <th class="fx-pos">#</th><th class="fx-stname">Team</th>
          <th title="Played">P</th><th title="Wins">W</th><th title="Losses">L</th><th title="Ties">T</th>
          <th class="fx-pts" title="Points">Pts</th><th title="Net run rate">NRR</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <ul class="hint fx-points-note">
      <li>W = ${pts(p.win)}</li>
      <li>T = ${pts(p.tie)}</li>
      <li>L = ${pts(p.loss)}</li>
      <li>NR = ${pts(p.abandoned)} Per Team</li>
    </ul>`;
  }

  /* ============================ RENDER: view ========================= */
  function render() {
    const view = document.getElementById("view-fixtures");
    if (!view) return;
    if (!eng()) { view.innerHTML = `<div class="view-head"><h2>FIXTURES &amp; RESULTS</h2></div>${emptyState("Engine unavailable", "Reload the page.")}`; return; }

    const mine = matches.filter(visible);
    const upcoming = mine.filter(m => !isDone(m)).sort(sortUpcoming);
    const results = mine.filter(isDone).sort(sortRecent);

    const create = canEdit()
      ? `<div class="view-head-tools"><button class="btn btn-yellow" id="fxCreate">＋ Create Match</button></div>`
      : "";

    view.innerHTML = `
      <div class="view-head"><h2>FIXTURES &amp; RESULTS</h2>${create}</div>
      <div class="fx-layout">
        <div class="fx-col">
          <section class="fx-block">
            <h3 class="fx-sec-title">📅 Upcoming Fixtures</h3>
            ${upcoming.length ? `<div class="fx-list">${upcoming.map(matchCard).join("")}</div>`
        : emptyState("No matches yet", canEdit() ? "Hit “Create Match” to schedule the first fixture." : "Fixtures appear here once the schedule is published.")}
          </section>
          <section class="fx-block">
            <h3 class="fx-sec-title">✅ Recent Results</h3>
            ${results.length ? `<div class="fx-list">${results.map(matchCard).join("")}</div>`
        : emptyState("No results yet", canEdit() ? "Import a Stumps match report to complete a fixture." : "Results appear here once matches are played.")}
          </section>
        </div>
        <aside class="fx-col fx-side">
          <section class="fx-block">
            <h3 class="fx-sec-title">🏆 Standings</h3>
            ${standingsTable()}
          </section>
        </aside>
      </div>`;
    // NOTE: deliberately does NOT re-render the modal. render() also fires on
    // every Firestore snapshot, and rebuilding an open form would wipe whatever
    // the admin is halfway through typing. The modal is redrawn only when the
    // modal state itself changes (open / close / after an action).
  }

  /* ============================= MODALS ============================== */
  function modalHost() {
    let el = document.getElementById("fxModal");
    if (!el) {
      el = document.createElement("div");
      el.id = "fxModal";
      el.className = "fx-backdrop hidden";
      document.body.appendChild(el);
      el.addEventListener("click", e => { if (e.target === el) closeModal(); });
    }
    return el;
  }
  function closeModal() { modal = null; renderModal(); }
  function renderModal() {
    const el = modalHost();
    if (!modal) { el.classList.add("hidden"); el.innerHTML = ""; return; }
    const html = modal.type === "form" ? formModal()
      : modal.type === "detail" ? detailModal()
        : modal.type === "import" ? importModal() : "";
    if (!html) { el.classList.add("hidden"); el.innerHTML = ""; return; }
    el.innerHTML = html;
    el.classList.remove("hidden");
  }
  function shell(title, body, foot) {
    return `<div class="fx-modal" role="dialog" aria-modal="true">
      <header class="fx-modal-head">
        <h3>${esc(title)}</h3>
        <button class="btn btn-dark btn-mini" data-fx-close="1">✕ Close</button>
      </header>
      <div class="fx-modal-body">${body}</div>
      ${foot ? `<footer class="fx-modal-foot">${foot}</footer>` : ""}
    </div>`;
  }

  /* ---------------------- create / edit match form ------------------- */
  function squadListHtml(teamId, label) {
    const squad = squadOf(teamId);
    if (!teamId) return `<div class="fx-squad"><h5>${esc(label)}</h5><p class="hint">Pick a team to load its squad.</p></div>`;
    if (!squad.length) return `<div class="fx-squad"><h5>${esc(label)}</h5><p class="hint">No players in this squad yet (they're assigned in the auction).</p></div>`;
    return `<div class="fx-squad">
      <h5>${esc(label)} <span class="fx-squad-n">${squad.length}</span></h5>
      <ul>${squad.map(p => `<li>${esc(p.name)}${p.role ? `<span class="fx-role">${esc(p.role)}</span>` : ""}${p.retained ? `<span class="fx-role fx-ret">retained</span>` : ""}</li>`).join("")}</ul>
    </div>`;
  }

  function formModal() {
    const d = modal.draft;
    const ts = teams();
    const opts = (sel, exclude) => `<option value=""> select team </option>` + ts
      .filter(t => t.id !== exclude || !exclude)
      .map(t => `<option value="${esc(t.id)}"${t.id === sel ? " selected" : ""}>${esc(t.name)}</option>`).join("");
    const statusOpts = eng().STATUSES.map(s =>
      `<option value="${s}"${d.status === s ? " selected" : ""}>${eng().STATUS_LABEL[s]}</option>`).join("");
    const fmtOpts = eng().FORMATS.map(f =>
      `<option value="${esc(f)}"${d.format === f ? " selected" : ""}>${esc(f)}</option>`).join("");
    const curStage = eng().stageOf(d);
    const stageOpts = eng().STAGES.map(s =>
      `<option value="${s.id}"${curStage === s.id ? " selected" : ""}>${esc(s.label)}</option>`).join("");
    // Spell out the consequence of the choice, right where it's made.
    const stageNote = eng().stageMeta(curStage).table
      ? `<span class="hint">✅ Group stage  the result <b>counts</b> towards the standings.</span>`
      : `<span class="hint fx-hint-knockout">🏆 Knockout  the result will <b>not</b> add points to the standings.</span>`;

    const body = `
      <div class="fx-form">
        <div class="fx-form-row">
          <label>Home team
            <select id="fxHome">${opts(d.homeTeamId, d.awayTeamId)}</select>
          </label>
          <label>Away team
            <select id="fxAway">${opts(d.awayTeamId, d.homeTeamId)}</select>
          </label>
        </div>
        <label>Match stage
          <select id="fxStage">${stageOpts}</select>
          ${stageNote}
        </label>
        <div class="fx-form-row">
          <label>Date &amp; time
            <input type="datetime-local" id="fxWhen" value="${esc(toLocalInput(d.scheduledAt))}" />
          </label>
          <label>Venue / location
            <input type="text" id="fxVenue" placeholder="e.g. Stumps Arena" value="${esc(d.venue)}" />
          </label>
        </div>
        <div class="fx-form-row">
          <label>Format
            <select id="fxFormat">${fmtOpts}</select>
          </label>
          <label>Status
            <select id="fxStatus">${statusOpts}</select>
          </label>
        </div>
        <label>Toss <span class="fx-opt">(optional)</span>
          <input type="text" id="fxToss" placeholder="e.g. Zyco Kings won the toss and chose to bat" value="${esc(d.toss)}" />
        </label>
        <label>Notes / description <span class="fx-opt">(optional)</span>
          <textarea id="fxNotes" rows="3" placeholder="Anything worth noting about this match…">${esc(d.notes)}</textarea>
        </label>
        <div class="fx-squads">
          ${squadListHtml(d.homeTeamId, teamName(d.homeTeamId) === "TBD" ? "Home squad" : teamName(d.homeTeamId))}
          ${squadListHtml(d.awayTeamId, teamName(d.awayTeamId) === "TBD" ? "Away squad" : teamName(d.awayTeamId))}
        </div>
      </div>`;
    const foot = `<button class="btn btn-dark" data-fx-close="1">Cancel</button>
      <button class="btn btn-yellow" id="fxSave">${modal.isNew ? "Create Match" : "Save Changes"}</button>`;
    return shell(modal.isNew ? "Create Match" : "Edit Match", body, foot);
  }

  // Read the form back into the draft (so a re-render - e.g. after picking a
  // team to load its squad - never loses what's already typed).
  function readForm() {
    const d = modal.draft;
    const get = id => document.getElementById(id);
    if (get("fxHome")) d.homeTeamId = get("fxHome").value;
    if (get("fxAway")) d.awayTeamId = get("fxAway").value;
    if (get("fxWhen")) d.scheduledAt = fromLocalInput(get("fxWhen").value);
    if (get("fxVenue")) d.venue = get("fxVenue").value.trim();
    if (get("fxFormat")) d.format = get("fxFormat").value;
    if (get("fxStage")) d.stage = get("fxStage").value;
    if (get("fxStatus")) d.status = get("fxStatus").value;
    if (get("fxToss")) d.toss = get("fxToss").value.trim();
    if (get("fxNotes")) d.notes = get("fxNotes").value.trim();
  }

  async function saveForm() {
    readForm();
    const d = modal.draft;
    if (!d.homeTeamId || !d.awayTeamId) return toast("Pick both teams", "bad");
    if (d.homeTeamId === d.awayTeamId) return toast("A team can't play itself", "bad");
    // Snapshot the squads from the auction data at save time.
    d.homeSquad = squadOf(d.homeTeamId);
    d.awaySquad = squadOf(d.awayTeamId);
    try {
      await putMatch(d);
      toast(modal.isNew ? "Match created" : "Match updated", "good");
      closeModal();
    } catch (e) {
      console.error(e); toast("Couldn't save the match", "bad");
    }
  }

  /* --------------------------- match details ------------------------- */
  function battingCard(players, team) {
    const rows = players.filter(p => p.team === team && p.batting && p.batting.batted);
    if (!rows.length) return "";
    return `<div class="fx-table-wrap"><table class="fx-table fx-card-table">
      <thead><tr><th class="fx-stname">${esc(team)}  Batting</th><th>R</th><th>B</th><th>4s</th><th>6s</th><th>SR</th></tr></thead>
      <tbody>${rows.map(p => `<tr>
        <td class="fx-stname">${esc(p.name)}${p.batting.out ? "" : `<span class="fx-no">not out</span>`}</td>
        <td class="fx-pts">${p.batting.runs}</td><td>${p.batting.balls}</td>
        <td>${p.batting.fours}</td><td>${p.batting.sixes}</td><td>${p.batting.sr}</td>
      </tr>`).join("")}</tbody>
    </table></div>`;
  }
  function bowlingCard(players, team) {
    const rows = players.filter(p => p.team === team && p.bowling && p.bowling.bowled);
    if (!rows.length) return "";
    return `<div class="fx-table-wrap"><table class="fx-table fx-card-table">
      <thead><tr><th class="fx-stname">${esc(team)}  Bowling</th><th>O</th><th>M</th><th>R</th><th>W</th><th>Eco</th></tr></thead>
      <tbody>${rows.map(p => `<tr>
        <td class="fx-stname">${esc(p.name)}</td>
        <td>${p.bowling.overs}</td><td>${p.bowling.maidens}</td><td>${p.bowling.runs}</td>
        <td class="fx-pts">${p.bowling.wickets}</td><td>${p.bowling.eco}</td>
      </tr>`).join("")}</tbody>
    </table></div>`;
  }

  function lineupHtml(squad, label) {
    if (!squad || !squad.length) return "";
    return `<div class="fx-squad"><h5>${esc(label)}</h5>
      <ul>${squad.map(p => `<li>${esc(p.name)}${p.role ? `<span class="fx-role">${esc(p.role)}</span>` : ""}</li>`).join("")}</ul></div>`;
  }

  function detailModal() {
    const m = matches.find(x => x.id === modal.matchId);
    if (!m) return shell("Match", emptyState("Match not found", "It may have just been deleted."), "");
    const rd = m.resultData, sc = m.scorecardData;
    const winnerId = rd ? eng().effectiveWinnerId(m) : "";
    const so = eng().superOverOf(m);

    // Super Over line: the tie-breaker scores, shown under the main result.
    const soLine = so ? `<div class="fx-superover">
      <span class="fx-so-tag">⚡ Super Over</span>
      <span>${esc(teamName(m.homeTeamId))} <b>${esc(String((so.home && so.home.runs) || 0))}/${esc(String((so.home && so.home.wickets) || 0))}</b></span>
      <span class="fx-vs">vs</span>
      <span>${esc(teamName(m.awayTeamId))} <b>${esc(String((so.away && so.away.runs) || 0))}/${esc(String((so.away && so.away.wickets) || 0))}</b></span>
      <span class="fx-so-win">${esc(teamName(so.winnerTeamId))} won</span>
    </div>` : "";

    const head = `<div class="fx-detail-head">
      <div class="fx-teams fx-teams-lg">
        <div class="fx-team${winnerId === m.homeTeamId ? " fx-won" : ""}">
          ${teamLogoHtml(m.homeTeamId, "fx-logo lg")}
          <span class="fx-tname">${esc(teamName(m.homeTeamId))}</span>
          ${scoreLine(m, "home")}
        </div>
        <span class="fx-vs">vs</span>
        <div class="fx-team${winnerId === m.awayTeamId ? " fx-won" : ""}">
          ${teamLogoHtml(m.awayTeamId, "fx-logo lg")}
          <span class="fx-tname">${esc(teamName(m.awayTeamId))}</span>
          ${scoreLine(m, "away")}
        </div>
      </div>
      <div class="fx-chips">${statusChip(m)}${draftChip(m)}</div>
      ${rd && rd.summary ? `<div class="fx-summary big">🏆 ${esc(rd.summary)}</div>` : `<div class="fx-pending big">Result pending</div>`}
      ${soLine}
      ${rd && rd.potm ? `<div class="fx-potm">⭐ Player of the Match: <b>${esc(rd.potm)}</b></div>` : ""}
    </div>`;

    const stage = eng().stageMeta(eng().stageOf(m));
    const facts = `<dl class="fx-facts">
      <div><dt>Stage</dt><dd>${esc(stage.label)}</dd></div>
      <div><dt>Date &amp; time</dt><dd>${esc(fmtDate(m.scheduledAt))}</dd></div>
      <div><dt>Venue</dt><dd>${esc(m.venue || "")}</dd></div>
      <div><dt>Format</dt><dd>${esc(m.format || "")}</dd></div>
      <div><dt>Toss</dt><dd>${esc(m.toss || "")}</dd></div>
    </dl>
    ${stage.table ? "" : `<p class="hint fx-hint-knockout">🏆 Knockout match  this result does not count towards the standings.</p>`}`;

    // No scorecard yet: show nothing here. The "Result pending" state above
    // already says where the match stands, and the squads are listed below.
    const cards = sc && sc.players && sc.players.length
      ? (sc.teams || []).map(t => battingCard(sc.players, t.name) + bowlingCard(sc.players, t.name)).join("")
      : "";

    const lineups = (!sc || !sc.players || !sc.players.length)
      ? `<div class="fx-squads">
          ${lineupHtml(m.homeSquad, teamName(m.homeTeamId))}
          ${lineupHtml(m.awaySquad, teamName(m.awayTeamId))}
        </div>` : "";

    const notes = m.notes ? `<div class="fx-notes"><h5>Match notes</h5><p>${esc(m.notes)}</p></div>` : "";

    const foot = canEdit()
      ? `<button class="btn btn-dark" data-fx-import="${esc(m.id)}">⬆ Import Stumps Report</button>
         <button class="btn btn-dark" data-fx-edit="${esc(m.id)}">✎ Edit</button>
         <button class="btn btn-yellow" data-fx-close="1">Done</button>`
      : `<button class="btn btn-yellow" data-fx-close="1">Close</button>`;

    return shell("Match Details", head + facts + cards + lineups + notes, foot);
  }

  /* --------------------- import Stumps report (PDF) ------------------- */
  async function pickAndImport(id) {
    const m = matches.find(x => x.id === id);
    if (!m) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/pdf";
    input.onchange = () => { const f = input.files && input.files[0]; if (f) importPdf(m, f); };
    input.click();
  }

  async function importPdf(m, file) {
    if (!window.HCCLPdfText || !window.HCCLPdfText.extractLines)
      return toast("PDF reader not loaded - reload the page", "bad");
    if (!window.pdfjsLib) return toast("PDF reader didn't load (connection or ad-blocker?)", "bad");
    if (!mvp()) return toast("Parser not loaded - reload the page", "bad");

    busy = true;
    modal = { type: "import", matchId: m.id, loading: true };
    renderModal();
    try {
      const buf = await file.arrayBuffer();
      const lines = await window.HCCLPdfText.extractLines(buf);
      const parsed = mvp().parseLines(lines);
      const ok = parsed && parsed.teams && parsed.teams.length >= 2 && parsed.players && parsed.players.length;

      // Even a partial parse opens the confirm dialog: the admin fills in / fixes
      // whatever the PDF didn't give up, so an unreadable report is never a dead end.
      const rd = ok ? eng().deriveResult(parsed, m, teams()) : {
        resultType: "runs", winnerName: "", winnerTeamId: "", margin: 0, potm: "",
        home: { runs: 0, wickets: 0, balls: 0 }, away: { runs: 0, wickets: 0, balls: 0 },
      };
      rd.summary = eng().summarize(rd);

      modal = {
        type: "import", matchId: m.id, loading: false,
        draft: rd,
        parsed: ok ? parsed : null,
        file: { name: file.name, size: file.size },
        partial: !ok,
      };
      if (ok) toast("Report parsed - check the values and save", "good");
      else toast("Couldn't read the scorecard - enter the result manually", "bad");
    } catch (err) {
      console.error("Stumps import failed:", err);
      toast(err.message || "Import failed", "bad");
      modal = { type: "detail", matchId: m.id };
    } finally {
      busy = false;
      renderModal();
    }
  }

  function importModal() {
    const m = matches.find(x => x.id === modal.matchId);
    if (!m) return shell("Import", emptyState("Match not found", ""), "");
    if (modal.loading) {
      return shell("Import Stumps Report",
        `<div class="fx-loading"><div class="fx-spinner"></div><p>Reading the PDF and extracting the scorecard…</p></div>`, "");
    }
    const d = modal.draft;
    const ts = teams();
    const winOpts = `<option value=""> none </option>` + ts.map(t =>
      `<option value="${esc(t.id)}"${t.id === d.winnerTeamId ? " selected" : ""}>${esc(t.name)}</option>`).join("");
    const typeOpts = eng().RESULT_TYPES.map(r =>
      `<option value="${r}"${d.resultType === r ? " selected" : ""}>${
        r === "runs" ? "Won by runs" : r === "wickets" ? "Won by wickets"
          : r === "tie" ? "Tied" : r === "abandoned" ? "Abandoned" : "No result"}</option>`).join("");

    const banner = modal.partial
      ? `<div class="fx-warn">⚠️ The scorecard couldn't be read automatically. Enter the result below  it saves exactly the same way.</div>`
      : `<div class="fx-ok">✅ Parsed <b>${esc(modal.file.name)}</b>. Check every value, edit anything that's off, then save.</div>`;

    const scoreRow = (side, label) => {
      const s = d[side] || { runs: 0, wickets: 0, balls: 0 };
      return `<fieldset class="fx-scorebox">
        <legend>${esc(label)}</legend>
        <label>Runs<input type="number" min="0" id="fx_${side}_runs" value="${esc(String(s.runs || 0))}" /></label>
        <label>Wickets<input type="number" min="0" id="fx_${side}_wkts" value="${esc(String(s.wickets || 0))}" /></label>
        <label>Overs<input type="text" id="fx_${side}_ov" placeholder="e.g. 10.0" value="${esc(eng().ballsToOvers(s.balls || 0))}" /></label>
      </fieldset>`;
    };

    // Super Over: only meaningful when the match TIED. STUMPS doesn't export it
    // reliably, so it's entered here - optional, since not every tie goes to one.
    const so = d.superOver || {};
    const soOn = !!so.played;
    const soWinOpts = `<option value=""> select winner </option>` + ts.map(t =>
      `<option value="${esc(t.id)}"${t.id === so.winnerTeamId ? " selected" : ""}>${esc(t.name)}</option>`).join("");
    const superOverBlock = d.resultType !== "tie" ? "" : `
      <fieldset class="fx-scorebox fx-so-box">
        <legend>⚡ Super Over</legend>
        <label class="fx-check">
          <input type="checkbox" id="fxSoPlayed"${soOn ? " checked" : ""} />
          <span>A Super Over was played to decide this tie</span>
        </label>
        ${soOn ? `
          <div class="fx-so-grid">
            <label>${esc(teamName(m.homeTeamId))} runs<input type="number" min="0" id="fxSoHomeR" value="${esc(String((so.home && so.home.runs) || 0))}" /></label>
            <label>${esc(teamName(m.homeTeamId))} wkts<input type="number" min="0" id="fxSoHomeW" value="${esc(String((so.home && so.home.wickets) || 0))}" /></label>
            <label>${esc(teamName(m.awayTeamId))} runs<input type="number" min="0" id="fxSoAwayR" value="${esc(String((so.away && so.away.runs) || 0))}" /></label>
            <label>${esc(teamName(m.awayTeamId))} wkts<input type="number" min="0" id="fxSoAwayW" value="${esc(String((so.away && so.away.wickets) || 0))}" /></label>
          </div>
          <label>Super Over winner<select id="fxSoWinner">${soWinOpts}</select></label>
          <span class="hint fx-hint-so">⚡ The league records this as a <b>win and a loss</b> (${eng().CONFIG.points.superOverWin} / ${eng().CONFIG.points.superOverLoss} pts)  <b>not</b> a tie. Super Over runs don't affect net run rate.</span>
        ` : `<span class="hint">Leave unticked for a true tie  ${eng().CONFIG.points.tie} point each.</span>`}
      </fieldset>`;

    const body = `${banner}
      <div class="fx-form">
        ${scoreRow("home", teamName(m.homeTeamId) + " (home)")}
        ${scoreRow("away", teamName(m.awayTeamId) + " (away)")}
        <div class="fx-form-row">
          <label>Result type<select id="fxResType">${typeOpts}</select></label>
          <label>Winner<select id="fxWinner">${winOpts}</select></label>
        </div>
        ${superOverBlock}
        <div class="fx-form-row">
          <label>Margin <span class="fx-opt">(runs / wickets)</span>
            <input type="number" min="0" id="fxMargin" value="${esc(String(d.margin || 0))}" />
          </label>
          <label>Player of the Match <span class="fx-opt">(optional)</span>
            <input type="text" id="fxPotm" value="${esc(d.potm || "")}" />
          </label>
        </div>
        <label>Result summary
          <input type="text" id="fxSummary" value="${esc(d.summary || "")}" placeholder="e.g. Zyco Kings won by 12 runs" />
          <span class="hint">Auto-written from the fields above; edit it if you want different wording.</span>
        </label>
        ${modal.parsed ? `<p class="hint">Scorecard: <b>${modal.parsed.players.length}</b> players across ${modal.parsed.teams.map(t => esc(t.name)).join(" vs ")} will be saved with this match.</p>` : ""}
      </div>`;
    const foot = `<button class="btn btn-dark" data-fx-close="1">Cancel</button>
      <button class="btn btn-yellow" id="fxConfirmImport">Save &amp; Complete Match</button>`;
    return shell("Import Stumps Report", body, foot);
  }

  // Re-derive the summary whenever the admin changes a result field.
  function readImportForm() {
    const d = modal.draft;
    const get = id => document.getElementById(id);
    const n = id => { const el = get(id); return el ? Math.max(0, parseInt(el.value, 10) || 0) : 0; };
    ["home", "away"].forEach(side => {
      d[side] = d[side] || {};
      d[side].runs = n(`fx_${side}_runs`);
      d[side].wickets = n(`fx_${side}_wkts`);
      const ov = get(`fx_${side}_ov`);
      d[side].balls = ov ? eng().oversToBalls(ov.value) : (d[side].balls || 0);
    });
    if (get("fxResType")) d.resultType = get("fxResType").value;
    if (get("fxWinner")) {
      d.winnerTeamId = get("fxWinner").value;
      const t = teamById(d.winnerTeamId);
      d.winnerName = t ? t.name : "";
    }
    if (get("fxMargin")) d.margin = Math.max(0, parseInt(get("fxMargin").value, 10) || 0);
    if (get("fxPotm")) d.potm = get("fxPotm").value.trim();

    // ---- Super Over (only offered on a tie) ----
    if (d.resultType === "tie") {
      const chk = get("fxSoPlayed");
      const so = d.superOver || (d.superOver = { played: false, winnerTeamId: "", home: {}, away: {} });
      if (chk) so.played = chk.checked;
      if (so.played) {
        so.home = { runs: n("fxSoHomeR"), wickets: n("fxSoHomeW") };
        so.away = { runs: n("fxSoAwayR"), wickets: n("fxSoAwayW") };
        if (get("fxSoWinner")) so.winnerTeamId = get("fxSoWinner").value;
        const t = teamById(so.winnerTeamId);
        so.winnerName = t ? t.name : "";
      }
    } else if (d.superOver) {
      d.superOver.played = false;   // result type changed away from tie
    }

    // Re-write the summary from the (possibly edited) fields, unless the admin
    // typed their own wording.
    const auto = eng().summarize(buildResult(d));
    const sum = get("fxSummary");
    if (sum) {
      const untouched = !sum.value.trim() || sum.value.trim() === (d.summary || "").trim();
      d.summary = untouched ? auto : sum.value.trim();
    } else {
      d.summary = auto;
    }
  }

  // Shape the draft into the resultData the engine/summary expect.
  function buildResult(d) {
    const decisive = d.resultType === "runs" || d.resultType === "wickets";
    const so = d.superOver && d.superOver.played && d.superOver.winnerTeamId ? d.superOver : null;
    return {
      resultType: d.resultType,
      winnerTeamId: decisive ? d.winnerTeamId : "",
      winnerName: decisive ? ((teamById(d.winnerTeamId) || {}).name || "") : "",
      margin: d.margin || 0,
      potm: d.potm || "",
      superOver: so ? {
        winnerTeamId: so.winnerTeamId,
        winnerName: (teamById(so.winnerTeamId) || {}).name || "",
        home: { runs: (so.home && so.home.runs) || 0, wickets: (so.home && so.home.wickets) || 0 },
        away: { runs: (so.away && so.away.runs) || 0, wickets: (so.away && so.away.wickets) || 0 },
      } : null,
    };
  }

  async function confirmImport() {
    readImportForm();
    const m = matches.find(x => x.id === modal.matchId);
    if (!m) return closeModal();
    const d = modal.draft;
    const decisive = d.resultType === "runs" || d.resultType === "wickets";
    if (decisive && !d.winnerTeamId) return toast("Pick the winning team", "bad");
    // A ticked Super Over with no winner would silently score as a plain tie.
    if (d.resultType === "tie" && d.superOver && d.superOver.played && !d.superOver.winnerTeamId)
      return toast("Pick the Super Over winner (or untick Super Over)", "bad");

    const base = buildResult(d);
    const next = { ...m };
    next.status = "completed";
    next.resultData = {
      ...base,
      home: { runs: d.home.runs, wickets: d.home.wickets, balls: d.home.balls, name: teamName(m.homeTeamId) },
      away: { runs: d.away.runs, wickets: d.away.wickets, balls: d.away.balls, name: teamName(m.awayTeamId) },
      summary: d.summary || eng().summarize(base),
    };
    if (modal.parsed) {
      next.scorecardData = { teams: modal.parsed.teams, players: modal.parsed.players };
      if (modal.parsed.matchId) next.stumpsMatchId = modal.parsed.matchId;
    }
    if (modal.file) {
      const H = window.HCCL;
      next.importedReport = {
        name: modal.file.name, size: modal.file.size, importedAt: Date.now(),
        importedBy: H && H.user ? (H.user.email || H.user.uid || "") : "",
      };
    }
    try {
      await putMatch(next);
      toast("Match completed - standings updated", "good");
      modal = { type: "detail", matchId: m.id };
      renderModal();
    } catch (e) {
      console.error(e); toast("Couldn't save the result", "bad");
    }
  }

  /* ------------------------- admin actions --------------------------- */
  async function togglePublish(id) {
    const m = matches.find(x => x.id === id);
    if (!m) return;
    const next = { ...m, published: m.published === false };
    try {
      await putMatch(next);
      toast(next.published ? "Match published" : "Match unpublished (draft)", "good");
    } catch (e) { console.error(e); toast("Couldn't update the match", "bad"); }
  }
  async function del(id) {
    const m = matches.find(x => x.id === id);
    if (!m) return;
    if (!window.confirm(`Delete ${teamName(m.homeTeamId)} vs ${teamName(m.awayTeamId)}? This can't be undone.`)) return;
    try { await removeMatch(id); toast("Match deleted", "good"); if (modal) closeModal(); }
    catch (e) { console.error(e); toast("Couldn't delete the match", "bad"); }
  }

  /* ---------------------------- events ------------------------------- */
  function onClick(e) {
    if (e.target.closest("[data-fx-close]")) return closeModal();

    const create = e.target.closest("#fxCreate");
    if (create) { modal = { type: "form", isNew: true, draft: blankMatch() }; renderModal(); return; }

    const save = e.target.closest("#fxSave");
    if (save) return saveForm();

    const conf = e.target.closest("#fxConfirmImport");
    if (conf) return confirmImport();

    // Admin buttons live inside the card; stop them opening the details modal.
    const imp = e.target.closest("[data-fx-import]");
    if (imp) { e.stopPropagation(); return pickAndImport(imp.getAttribute("data-fx-import")); }

    const ed = e.target.closest("[data-fx-edit]");
    if (ed) {
      e.stopPropagation();
      const m = matches.find(x => x.id === ed.getAttribute("data-fx-edit"));
      if (m) { modal = { type: "form", isNew: false, draft: JSON.parse(JSON.stringify(m)) }; renderModal(); }
      return;
    }
    const pub = e.target.closest("[data-fx-publish]");
    if (pub) { e.stopPropagation(); return togglePublish(pub.getAttribute("data-fx-publish")); }

    const dl = e.target.closest("[data-fx-del]");
    if (dl) { e.stopPropagation(); return del(dl.getAttribute("data-fx-del")); }

    const open = e.target.closest("[data-fx-open]");
    if (open) { modal = { type: "detail", matchId: open.getAttribute("data-fx-open") }; renderModal(); }
  }

  // Picking a team re-renders the form so its squad loads; picking a stage
  // re-renders so the "counts / doesn't count" note updates. Typed input is
  // read back into the draft first, so nothing is lost.
  function onChange(e) {
    if (!modal) return;
    if (modal.type === "form") {
      if (e.target.closest("#fxHome") || e.target.closest("#fxAway") || e.target.closest("#fxStage")) {
        readForm();
        renderModal();
      }
      return;
    }
    if (modal.type === "import" && modal.draft) {
      // These two change the dialog's SHAPE ("Tied" reveals the Super Over
      // section; ticking it reveals the score fields), so redraw it.
      if (e.target.closest("#fxResType") || e.target.closest("#fxSoPlayed")) {
        readImportForm();
        renderModal();
        return;
      }
      // Any other edit (winner, scores, margin): just refresh the auto-written
      // summary in place. A full redraw here would steal focus mid-form.
      readImportForm();
      const sum = document.getElementById("fxSummary");
      if (sum && sum !== e.target && sum.value !== modal.draft.summary) sum.value = modal.draft.summary || "";
    }
  }

  function init() {
    const view = document.getElementById("view-fixtures");
    if (!view) return;
    loadLocal();

    view.addEventListener("click", onClick);
    modalHost().addEventListener("click", onClick);
    modalHost().addEventListener("change", onChange);
    view.addEventListener("keydown", e => {
      const card = e.target.closest("[data-fx-open]");
      if (card && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); card.click(); }
    });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && modal) closeModal(); });

    // Teams/squads changed (auction snapshot, edits) - refresh names, logos, table.
    document.addEventListener("hccl:data", () => { if (!busy) render(); });

    const tabs = document.getElementById("tabs");
    if (tabs) tabs.addEventListener("click", e => { if (e.target.closest('[data-tab="fixtures"]')) render(); });

    if (window.HCCL && typeof window.HCCL.onChange === "function") {
      window.HCCL.onChange(() => { startSync(); render(); });
    }
    render();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
