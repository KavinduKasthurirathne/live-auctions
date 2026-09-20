#!/usr/bin/env node
/* ============================================================
   Regenerate js/asset-manifest.js from the real files in assets/.

   Run this after adding, renaming or re-extensioning ANY image:
       node tools/gen-assets.js

   Why: the site is a static app with no build step, so it can't glob
   the filesystem at runtime - the file lists have to be committed as
   data. Hand-maintaining them is what let every player photo rot to a
   404 (code said ".jpeg", disk had ".jpg"). This script is the single
   source of truth instead.
   ============================================================ */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ASSETS = path.join(ROOT, "assets");
const OUT = path.join(ROOT, "js", "asset-manifest.js");

const IMG = /\.(png|jpe?g|webp|svg)$/i;
// When two files share a basename ("Sameera Gimhan.jpg" + ".jpeg") only one can
// win the lookup - pick deterministically and report the clash.
const EXT_RANK = { ".jpg": 0, ".jpeg": 1, ".png": 2, ".webp": 3, ".svg": 4 };

const TEAM_LOGO_DIRS = [
  "HCCL Team Logos",
  "Rising League Logos",
  "Legends League Logos",
  "Mini IPL Logos",
  "Test Championship Logos",
];

const warnings = [];

function listDir(rel) {
  const dir = path.join(ASSETS, rel);
  if (!fs.existsSync(dir)) { warnings.push(`folder missing: assets/${rel}`); return []; }
  return fs.readdirSync(dir).filter(f => IMG.test(f)).sort((a, b) => a.localeCompare(b));
}

const baseOf = f => f.replace(/\.[^.]+$/, "").trim().toLowerCase();
const extOf = f => (f.match(/\.[^.]+$/) || [""])[0].toLowerCase();

/* basename -> "assets/<dir>/<file>", newest-wins resolved by EXT_RANK. */
function indexFiles(entries, label) {
  const out = {};
  const chosen = {};
  entries.forEach(({ dir, file }) => {
    const key = baseOf(file);
    const rank = EXT_RANK[extOf(file)] != null ? EXT_RANK[extOf(file)] : 99;
    if (chosen[key] === undefined || rank < chosen[key]) {
      if (chosen[key] !== undefined) {
        warnings.push(`${label}: duplicate "${key}" - using ${file}`);
      }
      chosen[key] = rank;
      out[key] = `assets/${dir}/${file}`;
    } else {
      warnings.push(`${label}: duplicate "${key}" - ignoring ${file}`);
    }
  });
  return out;
}

/* ---- players ---- */
const playerFiles = listDir("Players");
const playerPhotoIndex = indexFiles(playerFiles.map(f => ({ dir: "Players", file: f })), "Players");

/* ---- team logos across every league folder ---- */
const teamEntries = [];
TEAM_LOGO_DIRS.forEach(d => listDir(d).forEach(f => teamEntries.push({ dir: d, file: f })));
const teamLogoIndex = indexFiles(teamEntries, "Team logos");

/* ---- season logos: "S<n> LOGO.<ext>" ---- */
const seasonLogos = {};
listDir("HCCL Logos").forEach(f => {
  const m = f.match(/^S\s*(\d+)\s*LOGO/i);
  if (m) seasonLogos[Number(m[1])] = `assets/HCCL Logos/${f}`;
  else warnings.push(`HCCL Logos: unrecognised name "${f}" (expected "S<n> LOGO.<ext>")`);
});

/* ---- tournament badges: raw list + basename index ---- */
const tournamentFiles = listDir("Tournament Logos");
const tournamentLogoIndex = indexFiles(
  tournamentFiles.map(f => ({ dir: "Tournament Logos", file: f })), "Tournament logos");

const manifest = {
  generatedAt: new Date().toISOString().slice(0, 10),
  counts: {
    players: Object.keys(playerPhotoIndex).length,
    teamLogos: Object.keys(teamLogoIndex).length,
    seasonLogos: Object.keys(seasonLogos).length,
    tournamentLogos: Object.keys(tournamentLogoIndex).length,
  },
  playerPhotoIndex,
  teamLogoIndex,
  seasonLogos,
  tournamentLogoIndex,
};

const json = JSON.stringify(manifest, null, 2).replace(/\n/g, "\n  ");
const banner = `/* ============================================================
   GENERATED FILE - do not edit by hand.
   Run \`node tools/gen-assets.js\` after adding/renaming anything in
   assets/ (players, team logos, season logos, tournament badges).

   Every lookup is keyed by the LOWERCASED file basename, so a name
   resolves regardless of case ("SUPER FIRE DRAGONS" -> the file).
   Consumers: season-archive.js, fantasy.js.
   ============================================================ */
window.HCCL_ASSETS = ${json};
`;

fs.writeFileSync(OUT, banner, "utf8");
console.log(`wrote js/asset-manifest.js`);
console.log(`  players:          ${manifest.counts.players}`);
console.log(`  team logos:       ${manifest.counts.teamLogos}`);
console.log(`  season logos:     ${manifest.counts.seasonLogos}`);
console.log(`  tournament logos: ${manifest.counts.tournamentLogos}`);
if (warnings.length) {
  console.log("\nwarnings:");
  warnings.forEach(w => console.log("  - " + w));
}
