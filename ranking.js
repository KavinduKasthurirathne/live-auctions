/* ============================================================
   HCCL Player Ranking - placeholder UI

   Renders into #view-ranking: three empty boards (Batting, Bowling,
   All-Rounder), each a Pos / Player Name / Rating table with a
   "Coming Soon..." placeholder instead of rows. The real ranking
   engine will be wired in later - when it is, replace the placeholder
   row with data rows and keep the same table structure.
   ============================================================ */
(function () {
  "use strict";

  const CATS = [
    { key: "batting",    label: "🏏 Batting" },
    { key: "bowling",    label: "🎯 Bowling" },
    { key: "allrounder", label: "⭐ All-Rounder" },
  ];

  // The old ranking engine stored data on this device - tidy it up.
  const OLD_KEYS = [
    "hccl_ranking_history_v1", "hccl_ranking_latest_v1",
    "hccl_ranking_data_v2", "hccl_ranking_latest_v2",
  ];

  function tableHtml() {
    return `
      <div class="rank-card">
        <table class="rank-table">
          <thead>
            <tr><th class="rk-pos">Pos</th><th class="rk-name">Player Name</th><th class="rk-rating">Rating</th></tr>
          </thead>
          <tbody>
            <tr><td colspan="3" class="rank-empty">
              <span class="rank-soon">Coming Soon...</span>
              Till that try to improve your stats 💪
            </td></tr>
          </tbody>
        </table>
      </div>`;
  }

  function render() {
    const view = document.getElementById("view-ranking");
    if (!view) return;
    view.innerHTML = `
      <div class="view-head"><h2>PLAYER RANKING</h2></div>
      <div class="rank-sections">
        ${CATS.map(c => `
          <section class="rank-section">
            <h3 class="rank-sec-title">${c.label}</h3>
            ${tableHtml()}
          </section>`).join("")}
      </div>`;
  }

  function init() {
    try { OLD_KEYS.forEach(k => localStorage.removeItem(k)); } catch (e) {}
    render();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
