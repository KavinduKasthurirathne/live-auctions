/* ============================================================
   HC LIVE - the "Live Now" tab   (renders into #liveRoot)

   Ball-by-ball hand-cricket scoring. Scorers (admin / moderator)
   tap a digit; everyone else watches a broadcast scorecard that
   updates in real time on their own device.

   Deliberately standalone: this tab shares nothing with the
   auction, tournaments, fixtures or fantasy. Its own Firestore
   collection (liveMatches/{id}), its own teams, its own players.

   Storage mirrors the rest of the app: Firestore in live mode
   (real-time for everyone), localStorage when Firebase is not
   configured - so the tab still works offline exactly like the
   auction does.

   The document stores the SETTINGS and an ordered EVENT LIST,
   never a score. js/live-engine.js folds the events into every
   number on screen, which is why Undo is exact (drop the last
   event and recompute) and why two devices can never disagree.
   ============================================================ */
(function () {
  "use strict";

  const LS_KEY = "hccl_live_v1";
  const COLL = "liveMatches";

  let matches = [];          // all match docs
  let cloud = false;         // Firestore-backed?
  let syncStarted = false;
  let unsub = null;
  let retries = 0;           // consecutive transient failures (drives the backoff)

  let screen = "lobby";      // lobby | match | form
  let openId = null;         // the match being watched/scored
  let draft = null;          // the match being edited in the form
  let formMounted = false;   // the form owns its DOM; snapshots must not wipe typing
  let scPick = null;         // scorecard tab: null = follow the live innings
  let busy = false;          // a write is in flight - blocks double-taps

  const eng = () => window.HCCLLiveEngine;

  /* ------------------------------ helpers ------------------------------ */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function toast(m, k) { if (typeof window.toast === "function") window.toast(m, k); else console.log("[Live]", m); }
  function canEdit() {
    const H = window.HCCL;
    return !H || !H.configured || !!(H.user && H.canEdit && H.canEdit());
  }
  const uid = p => (p || "l") + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const root = () => document.getElementById("liveRoot");
  const byId = id => matches.find(m => m.id === id) || null;

  /* --------------------------- storage: local --------------------------- */
  function loadLocal() {
    try { const raw = localStorage.getItem(LS_KEY); matches = raw ? JSON.parse(raw) : []; }
    catch (e) { matches = []; }
    if (!Array.isArray(matches)) matches = [];
  }
  function saveLocal() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(matches)); }
    catch (e) { toast("Storage full - could not save the match", "bad"); }
  }

  /* --------------------------- storage: cloud --------------------------- */
  function startSync() {
    const H = window.HCCL;
    if (syncStarted || !H || !H.configured || !H.user || !H.db || !H.fs) return;
    const fs = H.fs;
    if (!fs.collection || !fs.onSnapshot) return;
    syncStarted = true; cloud = true;

    unsub = fs.onSnapshot(fs.collection(H.db, COLL), snap => {
      const docs = [];
      snap.forEach(d => docs.push(Object.assign({ id: d.id }, d.data())));
      matches = docs;
      retries = 0;
      render();
    }, err => {
      console.error("liveMatches snapshot error:", err);
      // onSnapshot's error callback is terminal - the listener is dead once it
      // fires - so a transient blip needs an explicit resubscribe rather than a
      // permanent drop to "this device only".
      if (window.HCCLSync && !window.HCCLSync.isTerminal(err)) { retryLater(); return; }
      cloud = false; syncStarted = false;
      loadLocal();
      toast("Live match sync unavailable - this device only", "bad");
      render();
    });
  }

  function retryLater() {
    if (unsub) { try { unsub(); } catch (e) {} unsub = null; }
    syncStarted = false;
    const wait = window.HCCLSync ? window.HCCLSync.backoff(retries++) : 4000;
    setTimeout(() => { if (!syncStarted) startSync(); }, wait);
  }

  function matchRef(id) {
    const H = window.HCCL;
    return H.fs.doc(H.db, COLL, id);
  }

  async function putMatch(m) {
    m.updatedAt = Date.now();
    if (cloud) {
      const H = window.HCCL;
      const data = Object.assign({}, m); delete data.id;
      data.updatedBy = H.user ? (H.user.email || H.user.uid || "") : "";
      await H.fs.setDoc(matchRef(m.id), data);
    } else {
      const i = matches.findIndex(x => x.id === m.id);
      if (i >= 0) matches[i] = m; else matches.push(m);
      saveLocal(); render();
    }
  }

  async function removeMatch(id) {
    if (cloud) await window.HCCL.fs.deleteDoc(matchRef(id));
    else { matches = matches.filter(m => m.id !== id); saveLocal(); render(); }
  }

  /* Append events. arrayUnion makes the append atomic, so two scorers tapping
     at the same moment both land instead of one silently overwriting the other.
     Every event carries a unique key precisely so union never dedupes two
     identical deliveries (two dot balls in a row are NOT the same event). */
  async function pushEvents(m, evs) {
    const stamped = evs.map(e => Object.assign({}, e, { k: uid("e"), ts: Date.now() }));
    if (cloud) {
      const fs = window.HCCL.fs;
      const patch = { updatedAt: Date.now() };
      patch.events = fs.arrayUnion
        ? fs.arrayUnion.apply(null, stamped)
        : (Array.isArray(m.events) ? m.events : []).concat(stamped);
      await fs.updateDoc(matchRef(m.id), patch);
    } else {
      m.events = (Array.isArray(m.events) ? m.events : []).concat(stamped);
      saveLocal(); render();
    }
  }

  /* Rewrite the whole list. Used by Undo - which is just "drop the last event",
     because nothing derived is ever stored. */
  async function setEvents(m, evs) {
    if (cloud) await window.HCCL.fs.updateDoc(matchRef(m.id), { events: evs, updatedAt: Date.now() });
    else { m.events = evs; saveLocal(); render(); }
  }

  /* A write that shows a spinner-ish guard and reports failures honestly. */
  async function act(fn) {
    if (busy) return;
    busy = true; render();
    try { await fn(); }
    catch (e) { console.error(e); toast("Could not save that - check your connection", "bad"); }
    finally { busy = false; render(); }
  }

  /* ---------------------------- match factory ---------------------------- */
  function blankMatch() {
    return {
      id: uid("m"),
      title: "", venue: "",
      teams: { A: { name: "", players: [] }, B: { name: "", players: [] } },
      overs: 5, wicketsLimit: 5, battingFirst: "A",
      events: [],
      createdAt: Date.now(), updatedAt: Date.now(),
      createdBy: (window.HCCL && window.HCCL.user && window.HCCL.user.email) || "",
    };
  }

  /* One name per line -> players. An existing player with the same name KEEPS
     its id, so fixing a typo in a squad mid-match never orphans the balls that
     player has already faced. */
  function parseSquad(text, existing) {
    const prev = Array.isArray(existing) ? existing.slice() : [];
    const taken = new Set();
    return String(text || "").split(/\r?\n/)
      .map(s => s.trim()).filter(Boolean)
      .map(name => {
        const hit = prev.find(p => !taken.has(p.id) && p.name.toLowerCase() === name.toLowerCase());
        if (hit) { taken.add(hit.id); return { id: hit.id, name }; }
        return { id: uid("p"), name };
      });
  }

  /* Status for the lobby, derived - never stored, so it can't drift. */
  function statusOf(st) {
    if (st.phase === "complete") return { key: "done", label: "Completed", cls: "is-done" };
    if (st.phase === "notStarted") return { key: "soon", label: "Ready to start", cls: "is-soon" };
    return { key: "live", label: "LIVE", cls: "is-live" };
  }

  const nameOf = (st, side, id) => eng().playerName(st.match, side, id) || "—";

  /* ================================ LOBBY ================================ */
  function lobbyHtml() {
    const rows = matches.map(m => ({ m, st: eng().compute(m) }));
    // Live first, then anything not yet started, then finished - newest within
    // each group.
    const rank = { live: 0, soon: 1, done: 2 };
    rows.sort((a, b) => {
      const d = rank[statusOf(a.st).key] - rank[statusOf(b.st).key];
      return d || (b.m.updatedAt || 0) - (a.m.updatedAt || 0);
    });

    const cards = rows.map(({ m, st }) => {
      const s = statusOf(st);
      const sides = eng().SIDES.slice().sort((x, y) => (x === st.battingFirst ? -1 : 1));
      const teamRows = sides.map(side => {
        const inn = st.innings.find(i => i.batSide === side);
        const batting = st.live && st.live.batSide === side;
        const won = st.result && st.result.winner === side;
        const played = inn && (inn.started || inn.balls > 0 || inn.closed);
        const score = played
          ? `${inn.runs}/${inn.wickets}<span class="lv-tov">(${eng().ballsToOvers(inn.balls)})</span>`
          : `<span class="lv-tov">yet to bat</span>`;
        return `<div class="lv-card-team${batting ? " is-batting" : ""}${won ? " is-winner" : ""}">
            <span class="lv-tname">${esc(eng().teamName(m, side))}</span>
            <span class="lv-tscore">${score}</span>
          </div>`;
      }).join("");

      let note = "";
      if (st.result) note = `<div class="lv-card-note is-result">🏆 ${esc(st.result.summary)}</div>`;
      else if (st.phase === "break") {
        const ch = eng().chaseInfo(st);
        note = `<div class="lv-card-note">Innings break · ${esc(eng().teamName(m, st.live.batSide))} need ${ch.target} to win</div>`;
      } else if (st.phase === "notStarted") {
        note = `<div class="lv-card-note">${st.overs} overs · ${st.wicketsLimit} wickets a side</div>`;
      } else {
        const ch = eng().chaseInfo(st);
        note = ch
          ? `<div class="lv-card-note">Need ${ch.need} off ${ch.ballsLeft} ball${ch.ballsLeft === 1 ? "" : "s"}</div>`
          : `<div class="lv-card-note">${st.overs} overs a side · CRR ${eng().fmt2(eng().runRate(st.live.runs, st.live.balls))}</div>`;
      }

      const title = m.title || `${eng().teamName(m, "A")} v ${eng().teamName(m, "B")}`;
      return `<article class="lv-card" data-lv-open="${esc(m.id)}" tabindex="0" role="button"
                aria-label="Open ${esc(title)}">
          <header class="lv-card-head">
            <span class="lv-card-title">${esc(m.venue || title)}</span>
            <span class="lv-chip ${s.cls}">${s.key === "live" ? '<i class="lv-dot"></i>' : ""}${esc(s.label)}</span>
          </header>
          <div>${teamRows}</div>
          ${note}
        </article>`;
    }).join("");

    const empty = `<div class="empty-state">
        <h2>No live matches yet</h2>
        <p>${canEdit()
          ? "Set one up and start scoring - everyone signed in will follow it ball by ball."
          : "Nothing is being scored right now. Check back when a match is on."}</p>
        ${canEdit() ? `<button class="btn btn-yellow lv-admin" data-lv-new>＋ New Match</button>` : ""}
      </div>`;

    return `<div class="view-head">
        <h2>🔴 LIVE NOW</h2>
        <div class="view-head-tools">
          <button class="btn btn-yellow lv-admin" data-lv-new>＋ New Match</button>
        </div>
      </div>
      ${matches.length ? `<div class="lv-list">${cards}</div>` : empty}`;
  }

  /* ============================== SCOREBOARD ============================== */
  function boardHtml(st) {
    const m = st.match;
    const s = statusOf(st);
    const inn = st.live || st.innings[1];
    const ch = eng().chaseInfo(st);
    const crr = eng().runRate(inn.runs, inn.balls);

    const chips = `<span class="lv-chip ${s.cls}">${s.key === "live" ? '<i class="lv-dot"></i>' : ""}${esc(s.label)}</span>
      <span class="lv-chip">${st.overs} ov</span>
      <span class="lv-chip">${st.wicketsLimit} wkts</span>
      ${st.phase === "break" ? `<span class="lv-chip is-soon">Innings break</span>` : ""}`;

    const meta = [
      { k: "This innings", v: `${inn.runs}/${inn.wickets}` },
      { k: "Overs", v: `${eng().ballsToOvers(inn.balls)} / ${st.overs}` },
      { k: "Run rate", v: eng().fmt2(crr) },
    ];
    if (ch) {
      meta.push({ k: "Target", v: String(ch.target), chase: true });
      meta.push({ k: "Req. rate", v: ch.ballsLeft ? eng().fmt2(ch.rrr) : "—", chase: true });
    }
    const metaHtml = meta.map(x =>
      `<div class="lv-meta-box${x.chase ? " is-chase" : ""}"><span class="k">${esc(x.k)}</span><span class="v">${x.v}</span></div>`
    ).join("");

    let line = "";
    if (st.result) {
      line = `<div class="lv-result${st.result.type === "tie" ? " is-tie" : ""}">🏆 ${esc(st.result.summary)}</div>`;
    } else if (ch) {
      const need = `<em>${ch.need} run${ch.need === 1 ? "" : "s"}</em> off <em>${ch.ballsLeft} ball${ch.ballsLeft === 1 ? "" : "s"}</em>`;
      line = `<div class="lv-need">${esc(eng().teamName(m, inn.batSide))} need ${need} with ${ch.wicketsLeft} wicket${ch.wicketsLeft === 1 ? "" : "s"} in hand</div>`;
    } else if (st.phase === "notStarted") {
      line = `<div class="lv-need">${esc(eng().teamName(m, st.battingFirst))} to bat first — waiting for the first ball</div>`;
    }

    // Once the chase is on, keep the first innings visible underneath it.
    const first = st.innings[0];
    const firstLine = inn.index === 1
      ? `<div class="lv-firstline">${esc(eng().teamName(m, first.batSide))} ${first.runs}/${first.wickets} (${eng().ballsToOvers(first.balls)} ov)${
          first.closeReason ? " · " + esc(eng().CLOSE_LABEL[first.closeReason] || "") : ""}</div>`
      : "";

    return `<section class="lv-board">
        <div class="lv-board-head">${chips}</div>
        <div class="lv-score-row">
          <span class="lv-score-team">${esc(eng().teamName(m, inn.batSide))}</span>
          <span class="lv-score-big">${inn.runs}/${inn.wickets}</span>
          <span class="lv-score-ov">(${eng().ballsToOvers(inn.balls)})</span>
        </div>
        ${firstLine}
        <div class="lv-meta">${metaHtml}</div>
        ${line}
      </section>`;
  }

  /* ================================ GROUND ================================ */
  /* A top-down 2D ground with the pitch, plus a wagon wheel of every scoring
     shot. The digits carry no real direction, so the angle is derived from the
     ball's index with the golden angle - decorative, but even and STABLE: the
     same ball always draws the same line, on every device, forever. */
  const GX = 150, GY = 150, GR = 133;    // ground centre + radius
  const BX = 150, BY = 191;              // the striker's end of the pitch

  function shotEnd(i, v) {
    const ang = ((i * 137.508) + 24) % 360;
    const rad = (ang - 90) * Math.PI / 180;
    const dx = Math.cos(rad), dy = Math.sin(rad);
    // Clip the ray to just inside the boundary so a six never draws outside it.
    const fx = BX - GX, fy = BY - GY;
    const b = fx * dx + fy * dy;
    const lim = GR - 13;
    const maxT = -b + Math.sqrt(Math.max(0, b * b - (fx * fx + fy * fy) + lim * lim));
    const len = Math.min(38 + v * 16, maxT);
    return { x: BX + dx * len, y: BY + dy * len, boundary: v >= 4 };
  }
  function shotColor(v) { return v === 6 ? "#ff3b1f" : v === 5 ? "#ff9a00" : v === 4 ? "#ffcc00" : "#7f9fb8"; }

  function groundHtml(st) {
    const inn = st.live || st.innings[1];
    const shots = [];
    inn.timeline.forEach((t, i) => {
      if (t.v === "W" || t.v === 0) return;
      const e = shotEnd(i, t.v);
      shots.push(`<line x1="${BX}" y1="${BY}" x2="${e.x.toFixed(1)}" y2="${e.y.toFixed(1)}"
          stroke="${shotColor(t.v)}" stroke-width="${t.v >= 4 ? 2 : 1.3}" stroke-linecap="round"
          opacity="${t.v >= 4 ? 0.95 : 0.55}"><title>${t.v} run${t.v === 1 ? "" : "s"}</title></line>`
        + (e.boundary ? `<circle cx="${e.x.toFixed(1)}" cy="${e.y.toFixed(1)}" r="3" fill="${shotColor(t.v)}"/>` : ""));
    });

    const striker = inn.strikerId ? nameOf(st, inn.batSide, inn.strikerId) : "";
    const bowler = inn.bowlerId ? nameOf(st, inn.bowlSide, inn.bowlerId) : "";
    const last = inn.timeline.length ? inn.timeline[inn.timeline.length - 1] : null;
    const lastCls = last ? (last.v === "W" ? "vW" : last.v === 6 ? "v6" : last.v === 4 ? "v4" : "") : "";

    return `<div class="lv-ground-wrap">
        <svg class="lv-ground" viewBox="0 0 300 300" role="img"
             aria-label="Ground with a wagon wheel of this innings' scoring shots">
          <defs>
            <radialGradient id="lvTurf" cx="50%" cy="38%" r="70%">
              <stop offset="0%" stop-color="#1a4d2e"/><stop offset="100%" stop-color="#0b2417"/>
            </radialGradient>
          </defs>
          <circle cx="${GX}" cy="${GY}" r="${GR}" fill="url(#lvTurf)" stroke="#2f6b45" stroke-width="2"/>
          <circle cx="${GX}" cy="${GY}" r="82" fill="none" stroke="#2f6b45" stroke-width="1.2"
                  stroke-dasharray="5 6" opacity="0.75"/>
          <rect x="139" y="104" width="22" height="94" rx="3" fill="#c9a56b" opacity="0.92"/>
          <line x1="145" y1="110" x2="155" y2="110" stroke="#f4ead6" stroke-width="1.6"/>
          <line x1="145" y1="192" x2="155" y2="192" stroke="#f4ead6" stroke-width="1.6"/>
          <g>${shots.join("")}</g>
          <circle cx="${BX}" cy="${BY}" r="5.5" fill="var(--yellow)" stroke="#1a1300" stroke-width="1.4"/>
          <circle cx="150" cy="108" r="5" fill="#e8e8ec" stroke="#1a1300" stroke-width="1.2"/>
          ${/* paint-order=stroke draws the dark outline BEHIND the glyphs, so a
                name stays readable wherever a wagon-wheel line runs under it. */""}
          ${striker ? `<text x="150" y="219" text-anchor="middle" fill="#ffcc00" font-size="11" font-weight="700"
            stroke="#08170f" stroke-width="3" paint-order="stroke">${esc(striker)}</text>` : ""}
          ${bowler ? `<text x="150" y="94" text-anchor="middle" fill="#dfe3e8" font-size="10.5"
            stroke="#08170f" stroke-width="3" paint-order="stroke">${esc(bowler)}</text>` : ""}
        </svg>
        ${last ? `<div class="lv-lastball ${lastCls}">${last.v === "W" ? "W" : last.v}</div>` : ""}
      </div>
      <div class="lv-wheel-key">
        <span><i style="background:#7f9fb8"></i>1–3</span>
        <span><i style="background:#ffcc00"></i>4</span>
        <span><i style="background:#ff9a00"></i>5</span>
        <span><i style="background:#ff3b1f"></i>6</span>
      </div>`;
  }

  /* ============================ AT THE CREASE ============================ */
  /* Once the match is over there is nobody at the crease, so the panel turns
     into the thing you actually want then: who won it. */
  function summaryHtml(st) {
    const rows = st.innings.map(inn => {
      const top = inn.batsmen.slice().sort((a, b) => b.runs - a.runs || a.balls - b.balls)[0];
      const best = inn.bowlers.slice().sort((a, b) => b.wickets - a.wickets || a.runs - b.runs)[0];
      if (!top && !best) return "";
      const bits = [];
      if (top) bits.push(`🏏 ${esc(nameOf(st, inn.batSide, top.id))} ${top.runs} (${top.balls})`);
      if (best) bits.push(`🎯 ${esc(nameOf(st, inn.bowlSide, best.id))} ${best.wickets}–${best.runs}`);
      return `<div class="lv-crease-row">
          <span class="lv-who">
            <span class="lv-role">${esc(eng().teamName(st.match, inn.batSide))} — ${inn.runs}/${inn.wickets} (${eng().ballsToOvers(inn.balls)} ov)</span>
            <span class="lv-name" style="font-size:13.5px;font-weight:500">${bits.join(" &nbsp;·&nbsp; ")}</span>
          </span>
        </div>`;
    }).join("");
    return `<div class="lv-crease">${rows}</div>`;
  }

  function creaseHtml(st) {
    const inn = st.live;
    if (!inn) return summaryHtml(st);
    const rows = [];
    if (inn.strikerId) {
      const b = inn.batsmen.find(x => x.id === inn.strikerId);
      rows.push(`<div class="lv-crease-row is-striker">
          <span class="lv-who">
            <span class="lv-role">Batting ★</span>
            <span class="lv-name">${esc(nameOf(st, inn.batSide, b.id))}</span>
          </span>
          <span>
            <span class="lv-figs">${b.runs} <small style="font-size:12px;color:var(--muted)">(${b.balls})</small></span>
            <span class="lv-sub">SR ${eng().fmt2(eng().strikeRate(b.runs, b.balls))} · ${b.fours}×4 · ${b.sixes}×6</span>
          </span>
        </div>`);
    } else {
      rows.push(`<div class="lv-crease-row"><span class="lv-who">
          <span class="lv-role">Batting</span>
          <span class="lv-name" style="color:var(--muted)">Waiting for the next batsman</span>
        </span></div>`);
    }
    if (inn.bowlerId) {
      const w = inn.bowlers.find(x => x.id === inn.bowlerId);
      rows.push(`<div class="lv-crease-row">
          <span class="lv-who">
            <span class="lv-role">Bowling</span>
            <span class="lv-name">${esc(nameOf(st, inn.bowlSide, w.id))}</span>
          </span>
          <span>
            <span class="lv-figs">${w.wickets}–${w.runs}</span>
            <span class="lv-sub">${eng().ballsToOvers(w.balls)} ov · Econ ${eng().fmt2(eng().economy(w.runs, w.balls))}</span>
          </span>
        </div>`);
    } else {
      rows.push(`<div class="lv-crease-row"><span class="lv-who">
          <span class="lv-role">Bowling</span>
          <span class="lv-name" style="color:var(--muted)">Waiting for the next bowler</span>
        </span></div>`);
    }
    return `<div class="lv-crease">${rows.join("")}</div>`;
  }

  /* ============================== THIS OVER ============================== */
  function overHtml(st) {
    const inn = st.live || st.innings[st.innings.length - 1];
    const over = inn.overs.length ? inn.overs[inn.overs.length - 1] : null;
    if (!over || !over.balls.length) {
      return `<div class="lv-panel"><h3>This over</h3><div class="lv-empty">No balls bowled yet.</div></div>`;
    }
    const chips = over.balls.map(v =>
      `<span class="lv-ball b${v === "W" ? "W" : v}">${v === "W" ? "W" : v}</span>`).join("");
    const pending = Array.from({ length: Math.max(0, 6 - over.balls.length) },
      () => `<span class="lv-ball is-pending">·</span>`).join("");
    const runs = over.balls.reduce((s, v) => s + (v === "W" ? 0 : v), 0);
    const wkts = over.balls.filter(v => v === "W").length;
    const who = over.bowlerId ? esc(nameOf(st, inn.bowlSide, over.bowlerId)) : "";

    return `<div class="lv-panel">
        <h3>Over ${over.n + 1}${who ? " · " + who : ""}</h3>
        <div class="lv-over-strip">
          ${chips}${pending}
          <span class="lv-over-tot">${runs} run${runs === 1 ? "" : "s"}${wkts ? ` · ${wkts} wkt${wkts === 1 ? "" : "s"}` : ""}</span>
        </div>
      </div>`;
  }

  /* ============================== SCORECARDS ============================== */
  function battingTable(st, inn) {
    if (!inn.batsmen.length) return `<div class="lv-empty">No one has batted yet.</div>`;
    const rows = inn.batsmen.map(b => {
      const isStriker = inn.strikerId === b.id;
      const how = b.out
        ? `<span class="lv-out">b ${esc(nameOf(st, inn.bowlSide, b.outBy))}</span>`
        : `<span class="lv-out">not out</span>`;
      return `<tr class="${isStriker ? "is-striker" : ""}">
          <td>${esc(nameOf(st, inn.batSide, b.id))}${isStriker ? " ★" : ""}${how}</td>
          <td class="lv-r">${b.runs}</td><td>${b.balls}</td><td>${b.fours}</td><td>${b.sixes}</td>
          <td>${eng().fmt2(eng().strikeRate(b.runs, b.balls))}</td>
        </tr>`;
    }).join("");

    const fow = inn.fow.length
      ? `<div class="lv-fow"><b>Fall of wickets:</b> ${inn.fow.map(f =>
          `${f.runs}/${f.wicket} (${esc(nameOf(st, inn.batSide, f.batId))}, ${eng().ballsToOvers(f.balls)} ov)`
        ).join(" · ")}</div>`
      : "";

    return `<div class="lv-table-wrap"><table class="lv-table">
        <thead><tr><th>Batsman</th><th>R</th><th>B</th><th>4s</th><th>6s</th><th>SR</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr>
          <td><b>Total</b></td><td class="lv-r"><b>${inn.runs}/${inn.wickets}</b></td>
          <td colspan="4">${eng().ballsToOvers(inn.balls)} ov · RR ${eng().fmt2(eng().runRate(inn.runs, inn.balls))}</td>
        </tr></tfoot>
      </table></div>${fow}`;
  }

  function bowlingTable(st, inn) {
    if (!inn.bowlers.length) return `<div class="lv-empty">No one has bowled yet.</div>`;
    const rows = inn.bowlers.map(w => `<tr class="${inn.bowlerId === w.id ? "is-striker" : ""}">
        <td>${esc(nameOf(st, inn.bowlSide, w.id))}${inn.bowlerId === w.id ? " ●" : ""}</td>
        <td>${eng().ballsToOvers(w.balls)}</td><td>${w.maidens}</td>
        <td>${w.runs}</td><td class="lv-r">${w.wickets}</td>
        <td>${eng().fmt2(eng().economy(w.runs, w.balls))}</td>
      </tr>`).join("");
    return `<div class="lv-table-wrap"><table class="lv-table">
        <thead><tr><th>Bowler</th><th>O</th><th>M</th><th>R</th><th>W</th><th>Econ</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
  }

  function commentaryHtml(st, inn) {
    if (!inn.timeline.length) return `<div class="lv-empty">No commentary yet.</div>`;
    const rows = inn.timeline.slice().reverse().map(t => {
      const bowler = esc(nameOf(st, inn.bowlSide, t.bowlerId));
      const bat = esc(nameOf(st, inn.batSide, t.batId));
      let txt;
      if (t.v === "W") txt = `<b>OUT!</b> ${bat} b ${bowler} — ${t.runs}/${t.wickets}`;
      else if (t.v === 0) txt = `${bowler} to ${bat}, <b>no run</b>`;
      else if (t.v === 6) txt = `${bowler} to ${bat}, <b>SIX!</b>`;
      else if (t.v === 4) txt = `${bowler} to ${bat}, <b>FOUR</b>`;
      else txt = `${bowler} to ${bat}, <b>${t.v} run${t.v === 1 ? "" : "s"}</b>`;
      return `<div class="lv-comm-row">
          <span class="lv-comm-ov">${t.over}.${t.ball}</span>
          <span class="lv-comm-txt">${txt}</span>
        </div>`;
    }).join("");
    return `<div class="lv-comm">${rows}</div>`;
  }

  function scorecardHtml(st) {
    const m = st.match;
    // Default to whichever innings is live; a manual pick sticks.
    const liveKey = st.live ? String(st.live.index) : "1";
    const key = scPick || liveKey;
    const tabs = st.innings.map((inn, i) => {
      const played = inn.started || inn.balls > 0 || inn.closed;
      return `<button class="lv-sc-tab${key === String(i) ? " active" : ""}" data-lv-sc="${i}"${played ? "" : " disabled"}>
          ${esc(eng().teamName(m, inn.batSide))} ${played ? `${inn.runs}/${inn.wickets}` : ""}
        </button>`;
    }).join("") + `<button class="lv-sc-tab${key === "comm" ? " active" : ""}" data-lv-sc="comm">💬 Commentary</button>`;

    let body;
    if (key === "comm") {
      const inn = st.live || st.innings[1];
      body = commentaryHtml(st, inn.timeline.length ? inn : st.innings[0]);
    } else {
      const inn = st.innings[Number(key)] || st.innings[0];
      body = battingTable(st, inn) + `<h3 style="margin:20px 0 12px">Bowling</h3>` + bowlingTable(st, inn);
    }
    return `<div class="lv-panel" style="margin-top:16px">
        <div class="lv-sc-tabs">${tabs}</div>
        ${body}
      </div>`;
  }

  /* ============================ SCORER PANEL ============================ */
  function scorerHtml(st) {
    if (!canEdit()) return "";
    const m = st.match;
    const dis = busy ? " disabled" : "";
    let body = "";
    let ask = "";

    if (st.phase === "complete") {
      ask = `Match complete — <em>${esc(st.result.summary)}</em>`;
      body = `<p class="lv-hint">Undo the last ball if it was entered by mistake; the result recalculates itself.</p>`;
    } else if (st.need === "bat") {
      const av = eng().availableBatsmen(st);
      const side = st.live.batSide;
      ask = st.live.started
        ? `Wicket! Who's in for <em>${esc(eng().teamName(m, side))}</em>?`
        : `Opening batsman for <em>${esc(eng().teamName(m, side))}</em>?`;
      body = av.length
        ? `<div class="lv-picks">${av.map(p =>
            `<button class="lv-pick" data-lv-bat="${esc(p.id)}"${dis}>${esc(p.name)}</button>`).join("")}</div>`
        : `<p class="lv-hint">Every batsman in this squad has batted. End the innings to move on.</p>`;
    } else if (st.need === "bowl") {
      const av = eng().availableBowlers(st);
      const inn = st.live;
      ask = `Who bowls over <em>${Math.floor(inn.balls / 6) + 1}</em> for ${esc(eng().teamName(m, inn.bowlSide))}?`;
      body = `<div class="lv-picks">${av.map(p => {
        const w = inn.bowlers.find(x => x.id === p.id);
        const figs = w ? `${eng().ballsToOvers(w.balls)}-${w.maidens}-${w.runs}-${w.wickets}` : "not bowled";
        return `<button class="lv-pick" data-lv-bowl="${esc(p.id)}"${dis}>
            <span>${esc(p.name)}</span><span class="lv-pick-figs">${figs}</span>
          </button>`;
      }).join("")}</div>`;
    } else {
      const inn = st.live;
      ask = `<em>${esc(nameOf(st, inn.bowlSide, inn.bowlerId))}</em> to <em>${esc(nameOf(st, inn.batSide, inn.strikerId))}</em> — tap what he scored`;
      body = `<div class="lv-pad">
          ${eng().DIGITS.map(d =>
            `<button class="lv-digit d${d}" data-lv-run="${d}"${dis} aria-label="${d} run${d === 1 ? "" : "s"}">${d}</button>`).join("")}
          <button class="lv-digit dW" data-lv-wkt${dis} aria-label="Bowled">W</button>
        </div>
        <p class="lv-hint">Strike never rotates — the same batsman keeps facing until he's bowled. Every wicket is credited to ${esc(nameOf(st, inn.bowlSide, inn.bowlerId))}.</p>`;
    }

    const hasEvents = (m.events || []).length > 0;
    const bar = `<div class="lv-scorer-bar">
        <button class="btn btn-dark" data-lv-undo${hasEvents && !busy ? "" : " disabled"}>↩ Undo last</button>
        ${st.phase !== "complete" && st.live && st.live.started
          ? `<button class="btn btn-dark" data-lv-endinn${dis}>⏹ End innings</button>` : ""}
        <button class="btn btn-dark" data-lv-edit="${esc(m.id)}">✎ Edit setup</button>
        <button class="btn btn-danger" data-lv-del="${esc(m.id)}">🗑 Delete match</button>
      </div>`;

    return `<section class="lv-scorer lv-admin">
        <div class="lv-scorer-head"><h3>SCORING PANEL</h3>
          <span class="lv-chip">${esc(window.HCCL && window.HCCL.configured ? window.HCCL.role : "offline")}</span>
        </div>
        <div class="lv-scorer-ask">${ask}</div>
        ${body}
        ${bar}
      </section>`;
  }

  /* ============================== MATCH VIEW ============================== */
  function matchHtml(m) {
    const st = eng().compute(m);
    const title = m.title || `${eng().teamName(m, "A")} v ${eng().teamName(m, "B")}`;
    return `<div class="lv-top">
        <button class="btn btn-dark btn-mini" data-lv-back>← All matches</button>
        <div>
          <div class="lv-top-title">${esc(title)}</div>
          ${m.venue ? `<div class="lv-top-sub">📍 ${esc(m.venue)}</div>` : ""}
        </div>
      </div>
      ${boardHtml(st)}
      <div class="lv-stage">
        <div class="lv-panel"><h3>Ground &amp; wagon wheel</h3>${groundHtml(st)}</div>
        <div class="lv-panel"><h3>${st.phase === "complete" ? "Match summary" : "At the crease"}</h3>${creaseHtml(st)}</div>
      </div>
      ${overHtml(st)}
      ${scorecardHtml(st)}
      ${scorerHtml(st)}`;
  }

  /* ================================ FORM ================================ */
  function formHtml() {
    const d = draft;
    const started = (d.events || []).length > 0;
    const lines = side => (d.teams[side].players || []).map(p => p.name).join("\n");
    return `<div class="lv-top">
        <button class="btn btn-dark btn-mini" data-lv-cancel>← Cancel</button>
        <div class="lv-top-title">${d.__isNew ? "New live match" : "Edit match"}</div>
      </div>
      ${started ? `<p class="lv-hint" style="margin-bottom:14px">This match is already under way. Renaming a player is safe — his balls follow him. Removing a player who has already batted will leave his name blank on the scorecard.</p>` : ""}
      <div class="lv-form">
        <div class="card">
          <h3>Match</h3>
          <label>Match title (optional)
            <input type="text" id="lvTitle" placeholder="e.g. Friday Night Special" value="${esc(d.title)}" />
          </label>
          <label>Venue (optional)
            <input type="text" id="lvVenue" placeholder="e.g. Colombo" value="${esc(d.venue)}" />
          </label>
          <label>Overs per innings
            <input type="number" id="lvOvers" min="1" max="50" step="1" value="${esc(d.overs)}" />
          </label>
          <label>Wickets per innings
            <input type="number" id="lvWkts" min="1" max="15" step="1" value="${esc(d.wicketsLimit)}" />
          </label>
          <label>Bats first
            <select id="lvFirst">
              <option value="A"${d.battingFirst === "A" ? " selected" : ""}>Team A</option>
              <option value="B"${d.battingFirst === "B" ? " selected" : ""}>Team B</option>
            </select>
          </label>
        </div>

        ${["A", "B"].map(side => `<div class="card">
          <h3>Team ${side}</h3>
          <label>Team name
            <input type="text" id="lvName${side}" placeholder="e.g. ${side === "A" ? "Royal Strikers" : "Night Riders"}"
                   value="${esc(d.teams[side].name)}" />
          </label>
          <label>Playing XI — one name per line
            <textarea id="lvSquad${side}" data-lv-squad="${side}"
              placeholder="Kasun Perera&#10;Nimal Silva&#10;Sunil Fernando">${esc(lines(side))}</textarea>
          </label>
          <div class="lv-count" id="lvCount${side}"></div>
        </div>`).join("")}
      </div>
      <div class="lv-errs" id="lvErrs"></div>
      <div class="lv-form-bar">
        <button class="btn btn-yellow" data-lv-save>${d.__isNew ? "Create match" : "Save changes"}</button>
        <button class="btn btn-dark" data-lv-cancel>Cancel</button>
      </div>`;
  }

  function countLines(side) {
    const ta = document.getElementById("lvSquad" + side);
    const el = document.getElementById("lvCount" + side);
    if (!ta || !el) return;
    const n = ta.value.split(/\r?\n/).filter(s => s.trim()).length;
    el.textContent = n === 0 ? "No players yet" : n + " player" + (n === 1 ? "" : "s");
    el.classList.toggle("is-bad", n === 0);
  }

  function wireForm() {
    ["A", "B"].forEach(side => {
      const ta = document.getElementById("lvSquad" + side);
      if (ta) ta.addEventListener("input", () => countLines(side));
      countLines(side);
    });
  }

  function readForm() {
    const d = draft;
    const v = id => { const el = document.getElementById(id); return el ? el.value : ""; };
    d.title = v("lvTitle").trim();
    d.venue = v("lvVenue").trim();
    d.overs = Math.max(1, Math.min(50, Math.floor(Number(v("lvOvers"))) || 1));
    d.wicketsLimit = Math.max(1, Math.min(15, Math.floor(Number(v("lvWkts"))) || 1));
    d.battingFirst = v("lvFirst") === "B" ? "B" : "A";
    ["A", "B"].forEach(side => {
      d.teams[side].name = v("lvName" + side).trim();
      d.teams[side].players = parseSquad(v("lvSquad" + side), d.teams[side].players);
    });
    return d;
  }

  async function saveForm() {
    const d = readForm();
    const errs = eng().validate(d);
    // A wickets limit above the squad size just means the innings ends when the
    // last man is out - the engine handles it - but it is nearly always a typo.
    ["A", "B"].forEach(s => {
      if (d.wicketsLimit > d.teams[s].players.length && d.teams[s].players.length)
        errs.push(`${d.teams[s].name || "Team " + s} has only ${d.teams[s].players.length} player(s) but the match allows ${d.wicketsLimit} wickets`);
    });
    const box = document.getElementById("lvErrs");
    if (errs.length) {
      if (box) box.innerHTML = errs.map(e => "• " + esc(e)).join("<br/>");
      return;
    }
    const isNew = d.__isNew;
    delete d.__isNew;
    await act(async () => {
      await putMatch(d);
      screen = "match"; openId = d.id; draft = null; formMounted = false; scPick = null;
      toast(isNew ? "Match created — start scoring" : "Match updated", "good");
    });
  }

  /* ================================ RENDER ================================ */
  function render() {
    const el = root();
    if (!el || !eng()) return;

    if (screen === "form" && draft) {
      // The form owns its DOM while it is open: re-rendering it under a live
      // snapshot would wipe whatever the scorer is halfway through typing.
      if (!formMounted) { el.innerHTML = formHtml(); formMounted = true; wireForm(); }
      return;
    }
    formMounted = false;

    if (screen === "match") {
      const m = byId(openId);
      if (!m) { screen = "lobby"; openId = null; el.innerHTML = lobbyHtml(); return; }
      el.innerHTML = matchHtml(m);
      return;
    }
    el.innerHTML = lobbyHtml();
  }

  /* ================================ EVENTS ================================ */
  function openMatch(id) {
    screen = "match"; openId = id; scPick = null;
    render();
    window.scrollTo(0, 0);
    if (window.HCCL) window.HCCL.track("live_match_open", { match_id: id });
  }

  function onClick(e) {
    const el = root();
    if (!el || !el.contains(e.target)) return;
    const hit = sel => e.target.closest(sel);

    if (hit("[data-lv-new]")) {
      draft = Object.assign(blankMatch(), { __isNew: true });
      screen = "form"; formMounted = false; render(); window.scrollTo(0, 0); return;
    }
    if (hit("[data-lv-cancel]")) {
      draft = null; formMounted = false;
      screen = openId && byId(openId) ? "match" : "lobby";
      render(); return;
    }
    if (hit("[data-lv-save]")) { saveForm(); return; }
    if (hit("[data-lv-back]")) { screen = "lobby"; openId = null; render(); window.scrollTo(0, 0); return; }

    const open = hit("[data-lv-open]");
    if (open) { openMatch(open.getAttribute("data-lv-open")); return; }

    const sc = hit("[data-lv-sc]");
    if (sc) { scPick = sc.getAttribute("data-lv-sc"); render(); return; }

    /* ---- everything below is a scorer action ---- */
    const m = byId(openId);
    if (!m || !canEdit()) return;

    const edit = hit("[data-lv-edit]");
    if (edit) {
      draft = JSON.parse(JSON.stringify(m));
      screen = "form"; formMounted = false; render(); window.scrollTo(0, 0); return;
    }
    const del = hit("[data-lv-del]");
    if (del) {
      const title = m.title || `${eng().teamName(m, "A")} v ${eng().teamName(m, "B")}`;
      if (!confirm(`Delete "${title}"? The scorecard and every ball of it go with it.`)) return;
      act(async () => {
        await removeMatch(m.id);
        screen = "lobby"; openId = null;
        toast("Match deleted", "good");
      });
      return;
    }

    const bat = hit("[data-lv-bat]");
    if (bat) { act(() => pushEvents(m, [{ t: "bat", p: bat.getAttribute("data-lv-bat") }])); return; }

    const bowl = hit("[data-lv-bowl]");
    if (bowl) { act(() => pushEvents(m, [{ t: "bowl", p: bowl.getAttribute("data-lv-bowl") }])); return; }

    const run = hit("[data-lv-run]");
    if (run) {
      const v = Number(run.getAttribute("data-lv-run"));
      act(() => pushEvents(m, [{ t: "ball", v }]));
      return;
    }
    if (hit("[data-lv-wkt]")) { act(() => pushEvents(m, [{ t: "wicket" }])); return; }

    if (hit("[data-lv-undo]")) {
      const evs = (m.events || []).slice(0, -1);
      act(() => setEvents(m, evs));
      return;
    }
    if (hit("[data-lv-endinn]")) {
      if (!confirm("End this innings now? The score stands where it is.")) return;
      act(() => pushEvents(m, [{ t: "endInnings" }]));
      return;
    }
  }

  /* Cards are keyboard-openable - they are role="button", so they must answer
     Enter and Space like one. */
  function onKey(e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    const card = e.target.closest && e.target.closest("[data-lv-open]");
    if (!card) return;
    e.preventDefault();
    openMatch(card.getAttribute("data-lv-open"));
  }

  /* ================================= BOOT ================================= */
  function init() {
    if (!document.getElementById("liveRoot")) return;
    loadLocal();
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    if (window.HCCL) {
      window.HCCL.onChange(() => { startSync(); render(); });
      startSync();
    }
    if (window.HCCLSync) window.HCCLSync.onReconnect(() => { retries = 0; startSync(); });
    render();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  // Small surface for the rest of the app (and for verification drivers).
  window.HCCLLive = {
    render,
    open: openMatch,
    matches: () => matches.slice(),
  };
})();
