#!/usr/bin/env node
/* ============================================================
   Make lightweight WebP copies of every image in assets/.

       npm i --no-save sharp        (once, on your machine)
       node tools/optimize-images.js
       node tools/gen-assets.js     (points the manifest at the copies)

   Why: the originals are full-size exports (player PNGs are ~1.5-2 MB
   each). The site shows them at 32-240 px, so a phone on a slow
   connection was downloading megabytes for a squads page. The copies
   are typically 15-60 KB.

   - Originals in assets/ are NEVER modified or deleted.
   - Copies go to assets-web/<same folder>/<same name>.webp - a separate
     tree, so tools/gen-assets.js never mistakes it for a logo folder.
   - Incremental: a copy newer than its original is skipped. Pass
     --force to rebuild everything.
   - SVGs are left alone (already tiny, and resolution-free).
   ============================================================ */
const fs = require("fs");
const path = require("path");

let sharp;
try { sharp = require("sharp"); }
catch (e) {
  console.error("This tool needs the 'sharp' image library:\n    npm i --no-save sharp\nthen run it again.");
  process.exit(1);
}

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "assets");
const OUT = path.join(ROOT, "assets-web");
const FORCE = process.argv.includes("--force");
const IMG = /\.(png|jpe?g|webp)$/i;

/* Longest edge (px) per kind - roughly 2x the largest size the UI shows. */
function sizeFor(rel) {
  const top = rel.split(path.sep)[0];
  const base = path.basename(rel).toLowerCase();
  if (/bg image/.test(base)) return { max: 1600, quality: 70 };        // hero / sign-in backgrounds
  if (base.startsWith("brand-logo")) return { max: 320, quality: 82 };
  if (top === "Players") return { max: 480, quality: 76 };              // auction card shows up to 240px
  return { max: 320, quality: 82 };                                     // team / tournament / season badges
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (IMG.test(e.name)) out.push(p);
  }
  return out;
}

(async () => {
  const files = walk(SRC);
  let made = 0, skipped = 0, before = 0, after = 0;
  for (const src of files) {
    const rel = path.relative(SRC, src);
    const dest = path.join(OUT, rel.replace(/\.[^.]+$/, ".webp"));
    const st = fs.statSync(src);
    if (!FORCE && fs.existsSync(dest) && fs.statSync(dest).mtimeMs >= st.mtimeMs) { skipped++; continue; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const { max, quality } = sizeFor(rel);
    try {
      await sharp(src)
        .rotate()                                   // honour EXIF orientation
        .resize({ width: max, height: max, fit: "inside", withoutEnlargement: true })
        .webp({ quality, alphaQuality: 90, effort: 5 })
        .toFile(dest);
      made++;
      before += st.size;
      after += fs.statSync(dest).size;
    } catch (err) {
      console.warn(`  ! skipped ${rel}: ${err.message}`);
    }
  }
  const mb = n => (n / 1048576).toFixed(1) + " MB";
  console.log(`optimized ${made} image(s), ${skipped} already up to date`);
  if (made) console.log(`  ${mb(before)} -> ${mb(after)} (${Math.round((1 - after / before) * 100)}% smaller)`);
  console.log("next: node tools/gen-assets.js");
})();
