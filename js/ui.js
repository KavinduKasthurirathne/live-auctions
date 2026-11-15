/* ============================================================
   Shared UI helpers (window.HCCLUI) - loaded before every other module.

   icon(name, cls)   -> inline <svg> referencing the Lucide sprite at the
                        top of index.html (<symbol id="i-<name>">). Icons are
                        decorative (aria-hidden); the label next to them is
                        what screen readers read.
   skeleton(kind, n) -> placeholder blocks shown while async data loads.
                        Carries a visually-hidden "Loading…" so assistive
                        tech still hears what the old text said.
   loadLib(key)      -> loads Chart.js / html-to-image the first time a
                        page needs them (Promise of the library global).
   ============================================================ */
(function () {
  "use strict";

  function icon(name, cls) {
    return `<svg class="ico${cls ? " " + cls : ""}" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;
  }

  // kind: "cards" (grid of card blocks) | "rows" (list rows) | "table" |
  // "tiles" (small stat tiles) | "line" (one short text line)
  function skeleton(kind, n, label) {
    const count = Math.max(1, n || 3);
    const sr = `<span class="sr-only">${label || "Loading…"}</span>`;
    const rep = (html) => Array.from({ length: count }, () => html).join("");
    let body;
    if (kind === "cards") {
      body = `<div class="skel-grid">${rep(`<div class="skel-card">
        <div class="skel-row"><span class="skel skel-avatar"></span><span class="skel skel-text w-60"></span></div>
        <span class="skel skel-text w-90"></span><span class="skel skel-text w-40"></span></div>`)}</div>`;
    } else if (kind === "table") {
      body = `<div class="skel-table">${rep(`<div class="skel-row"><span class="skel skel-text w-30"></span><span class="skel skel-text w-20"></span><span class="skel skel-text w-10"></span></div>`)}</div>`;
    } else if (kind === "tiles") {
      body = `<div class="skel-tiles">${rep(`<div class="skel-card"><span class="skel skel-text w-40"></span><span class="skel skel-stat"></span></div>`)}</div>`;
    } else if (kind === "line") {
      body = `<span class="skel skel-text w-40"></span>`;
    } else {
      body = `<div class="skel-list">${rep(`<div class="skel-row"><span class="skel skel-avatar"></span><span class="skel skel-text w-60"></span></div>`)}</div>`;
    }
    return `<div class="skel-wrap" role="status" aria-live="polite">${sr}${body}</div>`;
  }

  /* On-demand third-party scripts. Each URL is fetched at most once; the
     promise resolves when its global is ready and rejects if it's blocked
     (offline, ad-blocker) so callers can degrade gracefully. */
  const LIBS = {
    chart: { src: "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js", global: "Chart" },
    htmlToImage: { src: "https://cdn.jsdelivr.net/npm/html-to-image@1.11.13/dist/html-to-image.js", global: "htmlToImage" },
  };
  const pending = {};
  const failedAt = {};
  const RETRY_MS = 30000; // after a failure, don't re-request on every re-render
  function loadLib(key) {
    const lib = LIBS[key];
    if (!lib) return Promise.reject(new Error("unknown lib " + key));
    if (window[lib.global]) return Promise.resolve(window[lib.global]);
    if (pending[key]) return pending[key];
    if (failedAt[key] && Date.now() - failedAt[key] < RETRY_MS) return Promise.reject(new Error(key + " unavailable"));
    pending[key] = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = lib.src;
      s.async = true;
      const fail = msg => { delete pending[key]; failedAt[key] = Date.now(); s.remove(); reject(new Error(msg)); };
      s.onload = () => (window[lib.global] ? resolve(window[lib.global]) : fail(key + " missing"));
      s.onerror = () => fail(key + " failed to load");
      document.head.appendChild(s);
    });
    return pending[key];
  }

  window.HCCLUI = { icon, skeleton, loadLib };
})();
