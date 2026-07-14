/* ============================================================
   HCCL MVP Rankings  (renders into #view-mvp)

   Two live boards, backed by Firestore (realtime, like fantasy /
   ranking):
     • Season MVP   - every player ranked by Σ Final Match MVP score
                      (with matches played).
     • Match-wise MVP - per-match Final MVP score per player; pick a
                      match from the chips.

   Admins / moderators get an "⬆ Upload match PDF" button: it reads a
   STUMPS "Match Report" export in the browser (pdf.js), extracts the
   scorecard, and stores the PARSED match at mvp/{matchId}. Everyone
   signed in reads it; the scores are computed on the client by
   mvp-engine.js, so tuning the model + redeploy updates every board
   without re-uploading.
   ============================================================ */
(function () {
  "use strict";

  const TOP_N = 10;
  const PARSER_VERSION = "2026-07-06-1";
  const PDFJS_WORKER = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";

  let matches = [];        // parsed match docs from Firestore, sorted oldest->newest
  let selectedId = null;   // match chip currently shown
  let syncStarted = false;
  let mvpUnsub = null;     // active snapshot listener (dropped on tournament switch)
  let mvpTid = null;       // tournament id the listener belongs to
  // Tournament namespace (js/series.js): [] = legacy root, else ["tournaments", tid].
  const mvpPrefix = () => (window.HCCLSeries ? window.HCCLSeries.prefix() : []);
  let busy = false;        // an upload is being processed
  const ui = { expanded: false };

  const eng = () => window.HCCLMvp;
  const pad2 = n => String(n).padStart(2, "0");
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function toast(m, k) { if (typeof window.toast === "function") window.toast(m, k); else console.log("[MVP]", m); }
  function canEdit() {
    const H = window.HCCL;
    return !!(H && H.configured && H.user && H.canEdit && H.canEdit());
  }
  const sortKey = m => (m.ts || 0) || (m.uploadedAtMs || 0);

  /* --------------------------- team icons --------------------------- */
  // Committed team-logo files (assets/HCCL Team Logos). The STUMPS team names
  // are upper-cased ("SUPER FIRE DRAGONS"); we key the index by lowercased
  // basename so they resolve regardless of case. Add a file here to introduce
  // a team.
  const TEAM_LOGO_FILES = [
    "Aura Dynasty.jpeg", "Invincible Lords.jpeg", "Matrix.jpeg", "Mind Gamers.jpeg", "Silentearz.jpeg",
    "Super Fire Dragons.jpeg", "Velocity Reapers.jpeg", "Wizard Titans.jpeg", "Zyco Kings.jpeg",
  ];
  const TEAM_LOGO_INDEX = {};
  TEAM_LOGO_FILES.forEach(f => { TEAM_LOGO_INDEX[f.replace(/\.[^.]+$/, "").trim().toLowerCase()] = f; });
  function teamLogo(team) {
    const f = TEAM_LOGO_INDEX[String(team || "").trim().toLowerCase()];
    return f ? encodeURI(`assets/HCCL Team Logos/${f}`) : "";
  }

  const TEAM_COLORS = ["#e10600", "#f5b301", "#22c55e", "#3b82f6", "#a855f7", "#ec4899", "#14b8a6", "#f97316"];
  function teamColor(team) {
    let h = 0; team = String(team || "");
    for (let i = 0; i < team.length; i++) h = (h * 31 + team.charCodeAt(i)) | 0;
    return TEAM_COLORS[Math.abs(h) % TEAM_COLORS.length];
  }
  function teamIcon(team) {
    const t = String(team || "?");
    const logo = teamLogo(t);
    return logo
      ? `<span class="team-ico" title="${esc(t)}" style="background-image:url('${logo}')"></span>`
      : `<span class="team-ico" title="${esc(t)}" style="background:${teamColor(t)}">${esc(t[0] || "?")}</span>`;
  }
  function posCell(pos) {
    return pos === 1 ? "🥇" : pos === 2 ? "🥈" : pos === 3 ? "🥉" : pos;
  }

  /* ------------------- pdf.js: PDF -> text lines -------------------- */
  // Rebuild visual lines: bucket text items by y (top->bottom), sort each
  // row by x (left->right), and repair decimals split across items
  // ("300 . 0" -> "300.0") so the engine's number-tail regexes match.
  async function extractLines(buf) {
    const pdfjsLib = window.pdfjsLib;
    if (pdfjsLib.GlobalWorkerOptions && !pdfjsLib.GlobalWorkerOptions.workerSrc)
      pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const lines = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const buckets = [];
      content.items.forEach(it => {
        const s = it.str || "";
        if (!s.trim()) return;
        const y = it.transform[5], x = it.transform[4];
        let b = buckets.find(bk => Math.abs(bk.y - y) <= 3);
        if (!b) { b = { y, items: [] }; buckets.push(b); }
        b.items.push({ x, s });
      });
      buckets.sort((a, b) => b.y - a.y);
      buckets.forEach(b => {
        let row = b.items.sort((a, b) => a.x - b.x).map(o => o.s).join(" ");
        row = row.replace(/\s+/g, " ").replace(/(\d)\s*\.\s*(\d)/g, "$1.$2").trim();
        if (row) lines.push(row);
      });
    }
    return lines;
  }

  /* ----------------------- upload / persist ------------------------ */
  async function handleFile(file) {
    if (!file) return;
    if (!canEdit()) return toast("Only admins/moderators can upload match reports", "bad");
    if (!eng()) return toast("MVP engine not loaded", "bad");
    if (!window.pdfjsLib) return toast("PDF reader didn't load (connection or ad-blocker?)", "bad");
    const H = window.HCCL;
    if (!(H && H.db && H.fs && H.fs.setDoc)) return toast("Sign in as admin/moderator to upload", "bad");

    busy = true; render();
    try {
      const buf = await file.arrayBuffer();
      const lines = await extractLines(buf);
      const match = eng().parseLines(lines);
      if (!match.matchId) throw new Error("Couldn't read a Match ID - is this a STUMPS match report?");
      if (!match.teams || match.teams.length < 2 || !match.players.length)
        throw new Error("Couldn't read the scorecard from this PDF.");
      await saveMatch(match);
      selectedId = match.matchId;
      toast(`Uploaded: ${match.teams.map(t => t.name).join(" vs ")}`, "good");
    } catch (err) {
      console.error("MVP upload failed:", err);
      toast(err.message || "Upload failed", "bad");
    } finally {
      busy = false; render();
    }
  }

  async function saveMatch(match) {
    const H = window.HCCL, fs = H.fs;
    const ref = fs.doc(H.db, ...mvpPrefix(), "mvp", match.matchId);
    await fs.setDoc(ref, {
      matchId: match.matchId, title: match.title || "", dateText: match.dateText || "",
      ts: match.ts || 0, teams: match.teams || [], winner: match.winner || "",
      potm: match.potm || "", players: match.players || [],
      parserVersion: PARSER_VERSION,
      uploadedAtMs: Date.now(),
      uploadedAt: fs.serverTimestamp ? fs.serverTimestamp() : Date.now(),
      uploadedBy: H.user ? (H.user.email || H.user.uid || "") : "",
    });
  }

  async function deleteMatch(id) {
    const H = window.HCCL;
    if (!canEdit() || !(H && H.db && H.fs && H.fs.deleteDoc)) return;
    if (!window.confirm("Remove this match from the MVP rankings?")) return;
    try {
      await H.fs.deleteDoc(H.fs.doc(H.db, ...mvpPrefix(), "mvp", id));
      toast("Match removed", "good");
    } catch (err) { console.error(err); toast("Couldn't remove the match", "bad"); }
  }

  /* --------------------------- firestore --------------------------- */
  function startSync() {
    const H = window.HCCL, S = window.HCCLSeries;
    if (syncStarted || !H || !H.configured || !H.user || !H.db || !H.fs) return;
    if (S && !S.ready) return; // wait for the tournament registry
    const fs = H.fs;
    if (!fs.collection || !fs.onSnapshot) return;
    syncStarted = true;
    mvpTid = S ? S.viewingId() : null;
    mvpUnsub = fs.onSnapshot(fs.collection(H.db, ...mvpPrefix(), "mvp"), snap => {
      const docs = [];
      snap.forEach(d => docs.push(d.data()));
      docs.sort((a, b) => sortKey(a) - sortKey(b));
      matches = docs;
      if (!matches.find(m => m.matchId === selectedId))
        selectedId = matches.length ? matches[matches.length - 1].matchId : null;
      render();
    }, err => console.error("mvp snapshot error:", err));
  }

  /* Viewed tournament changed (js/series.js): drop the listener, resubscribe. */
  function onSeriesChange(S) {
    if (!S.ready) return;
    const tid = S.viewingId();
    if (syncStarted && tid === mvpTid) return;
    if (mvpUnsub) { try { mvpUnsub(); } catch (e) {} mvpUnsub = null; }
    if (syncStarted) { matches = []; selectedId = null; render(); }
    syncStarted = false;
    startSync();
  }

  /* --------------------------- rendering --------------------------- */
  function emptyCard(title, sub) {
    return `<div class="rank-card"><div class="mvp-empty">
      <span class="rank-soon">${esc(title)}</span>${esc(sub)}
    </div></div>`;
  }

  function seasonCard() {
    const rows = eng() ? eng().seasonTable(matches) : [];
    if (!rows.length) return emptyCard("No matches uploaded yet", "Upload a STUMPS match report to start the MVP race.");
    const expanded = ui.expanded;
    const shown = expanded ? rows : rows.slice(0, TOP_N);
    const hasMore = rows.length > TOP_N;
    const body = shown.map(r => `<tr>
      <td class="rk-pos">${posCell(r.pos)}</td>
      <td class="rk-name">${esc(r.name)}</td>
      <td class="rk-team">${teamIcon(r.team)}</td>
      <td class="mvp-num">${r.matches}</td>
      <td class="mvp-num strong">${r.total}</td>
    </tr>`).join("");
    const expander = hasMore ? `<button class="rank-expand" type="button" data-mvp-expand="1" aria-expanded="${expanded}">
      <span>${expanded ? `Show top ${TOP_N}` : `Show all ${rows.length}`}</span>
      <span class="rank-chevron" aria-hidden="true">▾</span></button>` : "";
    return `<div class="rank-card"><table class="rank-table mvp-table">
      <thead><tr>
        <th class="rk-pos">Pos</th><th class="rk-name">Player</th><th class="rk-team">Team</th>
        <th class="mvp-num" title="Matches played">Matches</th>
        <th class="mvp-num" title="Season MVP points">MVP</th>
      </tr></thead>
      <tbody>${body}</tbody></table>${expander}</div>`;
  }

  function matchMeta(m) {
    const teams = m.teams || [];
    const score = teams.map(x =>
      `<span class="mvp-team">${teamIcon(x.name)} <b>${esc(x.name)}</b> <span class="mvp-team-sc">${x.total}/${x.wickets}</span></span>`
    ).join(`<span class="mvp-vs">vs</span>`);
    // Resolve winner through the engine so older docs self-heal (winner from
    // totals, not the unreliable stored text).
    const info = eng() ? eng().matchInfo(m) : { winner: m.winner };
    const res = [];
    if (info.winner) res.push(`<span class="mvp-win">🏆 ${esc(info.winner)} won</span>`);
    if (m.dateText) res.push(`<span class="mvp-date">${esc(m.dateText)}</span>`);
    return `<div class="mvp-matchmeta">
      <div class="mvp-score">${score}</div>
      <div class="mvp-result">${res.join("")}</div>
    </div>`;
  }

  function matchSection() {
    if (!matches.length) return emptyCard("No matches yet", "Match MVP breakdowns appear here after the first upload.");
    if (!eng()) return emptyCard("Engine unavailable", "Reload the page.");
    const chips = matches.map((m, i) =>
      `<button class="mvp-chip${m.matchId === selectedId ? " active" : ""}" data-mvp-match="${esc(m.matchId)}">Match ${pad2(i + 1)}</button>`
    ).join("");
    const m = matches.find(x => x.matchId === selectedId) || matches[matches.length - 1];
    const rows = eng().computeMatch(m);
    const body = rows.map(r => `<tr>
      <td class="rk-pos">${posCell(r.pos)}</td>
      <td class="rk-name">${esc(r.name)}</td>
      <td class="rk-team">${teamIcon(r.team)}</td>
      <td class="mvp-num strong">${r.final}</td>
    </tr>`).join("");
    const del = canEdit() ? `<div class="mvp-foot"><button class="btn btn-danger" type="button" data-mvp-del="${esc(m.matchId)}">Delete this match</button></div>` : "";
    const options = matches.map((mm, i) => {
      const t = mm.teams || [];
      const label = `Match ${pad2(i + 1)} - ${(t[0] && t[0].name) || "?"} vs ${(t[1] && t[1].name) || "?"}`;
      return `<option value="${esc(mm.matchId)}"${mm.matchId === selectedId ? " selected" : ""}>${esc(label)}</option>`;
    }).join("");
    return `<select id="mvpMatchSelect" class="mvp-select" aria-label="Select a match">${options}</select>
      <div class="mvp-matchbar">${chips}</div>
      <div class="rank-card">
        ${matchMeta(m)}
        <table class="rank-table mvp-table">
          <thead><tr>
            <th class="rk-pos">Pos</th><th class="rk-name">Player</th><th class="rk-team">Team</th>
            <th class="mvp-num" title="Final Match MVP">Final</th>
          </tr></thead>
          <tbody>${body}</tbody>
        </table>
        ${del}
      </div>`;
  }

  function render() {
    const view = document.getElementById("view-mvp");
    if (!view) return;
    const uploader = canEdit() ? `<div class="view-head-tools">
        <label class="btn btn-yellow file-btn${busy ? " is-busy" : ""}">
          ${busy ? "Processing…" : "⬆ Upload match PDF"}
          <input type="file" id="mvpPdf" accept="application/pdf" hidden ${busy ? "disabled" : ""} />
        </label>
      </div>` : "";
    view.innerHTML = `
      <div class="view-head"><h2>MVP RANKINGS</h2>${uploader}</div>
      <div class="mvp-cols">
        <section class="mvp-block">
          <h3 class="rank-sec-title">📋 Match-wise MVP</h3>
          ${matchSection()}
        </section>
        <section class="mvp-block">
          <h3 class="rank-sec-title">🏆 Season MVP</h3>
          ${seasonCard()}
        </section>
      </div>`;
  }

  // Shared with fixtures.js: one implementation of "STUMPS PDF -> text lines".
  window.HCCLPdfText = { extractLines };

  /* ---------------------------- events ----------------------------- */
  function onClick(e) {
    const chip = e.target.closest("[data-mvp-match]");
    if (chip) { selectedId = chip.getAttribute("data-mvp-match"); render(); return; }
    const ex = e.target.closest("[data-mvp-expand]");
    if (ex) { ui.expanded = !ui.expanded; render(); return; }
    const del = e.target.closest("[data-mvp-del]");
    if (del) { deleteMatch(del.getAttribute("data-mvp-del")); return; }
  }
  function onChange(e) {
    const sel = e.target.closest("#mvpMatchSelect");
    if (sel) { selectedId = sel.value; render(); return; }
    const inp = e.target.closest("#mvpPdf");
    if (inp && inp.files && inp.files[0]) {
      const f = inp.files[0];
      inp.value = ""; // allow re-selecting the same file
      handleFile(f);
    }
  }

  function init() {
    const view = document.getElementById("view-mvp");
    if (!view) return;
    view.addEventListener("click", onClick);
    view.addEventListener("change", onChange);
    // Re-render when the MVP board opens (icons/role may have changed).
    // MVP lives under the Rankings tab, so watch both the top tab and our sub-tab.
    document.addEventListener("click", e => {
      if (e.target.closest('[data-tab="rankings"], [data-subtab="mvp"]')) render();
    });
    // Start realtime sync + reflect role (upload button) once signed in.
    if (window.HCCL && typeof window.HCCL.onChange === "function") {
      window.HCCL.onChange(() => { startSync(); render(); });
    }
    // Tournament switching (js/series.js) - resubscribe when the viewed one changes.
    if (window.HCCLSeries) window.HCCLSeries.onChange(onSeriesChange);
    render();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
