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

/* Folder roles. Team-logo folders are DISCOVERED, not listed: any folder under
   assets/ that isn't one of the special ones below is treated as a league's
   badge folder. A hand-kept list is exactly what let "County Championship
   Logos", "Freestyle Logos" and "Fatal 4 Logos" sit on disk unindexed - adding a
   new league should only ever mean dropping a folder in and re-running this. */
const PLAYER_DIR = "Players";
const SEASON_DIR = "HCCL Logos";
// Folders of TOURNAMENT badges (one image per tournament/season), not team crests.
const TOURNAMENT_LOGO_DIRS = ["Tournament Logos", "Tag Team Championship"];
// Precedence when two leagues have a team with the same name (the lookup is by
// name only). These keep their original order so no existing page changes;
// newly discovered folders come after, alphabetically.
const TEAM_LOGO_PRIORITY = [
  "HCCL Team Logos",
  "Rising League Logos",
  "Legends League Logos",
  "Mini IPL Logos",
  "Test Championship Logos",
];
// Images at the assets/ root that the site loads directly by path (index.html /
// CSS). Anything ELSE loose at the root is almost certainly a misplaced badge.
const ROOT_UI_ASSETS = /^(brand-logo|flag-sri-lanka|home-hero bg image|login-page\s+bg image|seasons bg image)\./i;

const warnings = [];
const notes = [];

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

const allDirs = fs.readdirSync(ASSETS, { withFileTypes: true })
  .filter(e => e.isDirectory()).map(e => e.name);
const special = new Set([PLAYER_DIR, SEASON_DIR, ...TOURNAMENT_LOGO_DIRS]);
const discovered = allDirs.filter(d => !special.has(d) && !TEAM_LOGO_PRIORITY.includes(d))
  .sort((a, b) => a.localeCompare(b));
const TEAM_LOGO_DIRS = [...TEAM_LOGO_PRIORITY.filter(d => allDirs.includes(d)), ...discovered];

/* ---- players ---- */
const playerFiles = listDir(PLAYER_DIR);
const playerPhotoIndex = indexFiles(playerFiles.map(f => ({ dir: PLAYER_DIR, file: f })), "Players");

/* ---- team logos across every league folder ----
   Two teams with one name in two leagues can only share one flat-index slot.
   That's reported as a NOTE (not a warning): in this community it's the same
   franchise re-entering, usually with a re-exported crest. The per-folder index
   below keeps every file, should a page ever need the league-specific one. */
const teamEntries = [];
const teamLogoFolders = {};
TEAM_LOGO_DIRS.forEach(d => {
  const files = listDir(d);
  teamLogoFolders[d] = {};
  files.forEach(f => {
    teamEntries.push({ dir: d, file: f });
    teamLogoFolders[d][baseOf(f)] = `assets/${d}/${f}`;
  });
});
const teamLogoIndex = {};
const teamOwner = {};
teamEntries.forEach(({ dir, file }) => {
  const key = baseOf(file);
  if (teamLogoIndex[key] === undefined) { teamLogoIndex[key] = `assets/${dir}/${file}`; teamOwner[key] = dir; }
  else if (teamOwner[key] !== dir) notes.push(`team "${key}" is in "${teamOwner[key]}" and "${dir}" - using ${teamOwner[key]}`);
  else warnings.push(`Team logos: duplicate "${key}" in "${dir}" - ignoring ${file}`);
});

/* ---- season logos: "S<n> LOGO.<ext>" ---- */
const seasonLogos = {};
listDir("HCCL Logos").forEach(f => {
  const m = f.match(/^S\s*(\d+)\s*LOGO/i);
  if (m) seasonLogos[Number(m[1])] = `assets/HCCL Logos/${f}`;
  else warnings.push(`HCCL Logos: unrecognised name "${f}" (expected "S<n> LOGO.<ext>")`);
});

/* ---- tournament badges: every tournament-logo folder, one basename index ---- */
const tournamentEntries = [];
TOURNAMENT_LOGO_DIRS.forEach(d => listDir(d).forEach(f => tournamentEntries.push({ dir: d, file: f })));
const tournamentLogoIndex = indexFiles(tournamentEntries, "Tournament logos");

/* ---- loose images at the assets/ root ---- */
fs.readdirSync(ASSETS, { withFileTypes: true })
  .filter(e => e.isFile() && IMG.test(e.name) && !ROOT_UI_ASSETS.test(e.name))
  .forEach(e => warnings.push(`loose file at assets/ root is NOT indexed: "${e.name}" - move it into a folder (e.g. Tournament Logos/)`));

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
  teamLogoFolders,
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
console.log(`  team-logo folders: ${TEAM_LOGO_DIRS.join(", ")}`);
if (notes.length) {
  console.log("\nnotes:");
  notes.forEach(n => console.log("  - " + n));
}
if (warnings.length) {
  console.log("\nwarnings:");
  warnings.forEach(w => console.log("  - " + w));
}
