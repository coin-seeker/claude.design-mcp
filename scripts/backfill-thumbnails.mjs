// Writes the static `.thumbnail` that artifacts pulls now produce into pull directories made
// before it existed, so the dashboard feed shows an image instead of a live frame. Only
// directories WITHOUT a `.thumbnail` are touched. One headless Chrome is shared by all renders.
// Usage:
//   node scripts/backfill-thumbnails.mjs [designsRoot] [--dry-run]
//   (designsRoot defaults to ~/.local/share/opencode-dashboard/designs)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright-core';

import { pickThumbnailDocument, THUMBNAIL_NAME, writeThumbnail } from '../src/artifacts/thumbnail.mjs';
import { assetContentType, canonicalMapKey } from '../src/preview-assets.mjs';
import { chromeBin } from '../src/session.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const root = path.resolve(args.find((arg) => !arg.startsWith('--'))
  ?? path.join(homedir(), '.local/share/opencode-dashboard/designs'));

// Dot entries (`.revisions`, `.thumbnail`, `.staging-*`) are bookkeeping, not design files.
function readAssets(dir) {
  const assets = new Map();
  const walk = (relative) => {
    for (const entry of readdirSync(path.join(dir, relative), { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile()) {
        assets.set(canonicalMapKey(rel), { path: rel, bytes: readFileSync(path.join(dir, rel)), contentType: assetContentType(null, rel) });
      }
    }
  };
  walk('');
  return assets;
}

const targets = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
  .map((entry) => path.join(root, entry.name))
  .filter((dir) => !existsSync(path.join(dir, THUMBNAIL_NAME)));

if (dryRun) {
  for (const dir of targets) console.log(`would render ${path.basename(dir)}`);
  console.log(`${targets.length} director${targets.length === 1 ? 'y' : 'ies'} without ${THUMBNAIL_NAME}`);
  process.exit(0);
}

const browser = await chromium.launch({ executablePath: chromeBin(), headless: true });
let ok = 0;
const skipped = [];
const failed = [];
try {
  for (const dir of targets) {
    const name = path.basename(dir);
    const assets = readAssets(dir);
    if (pickThumbnailDocument(assets.keys()) === null) {
      skipped.push(name);
      console.log(`skip ${name} (no HTML document)`);
      continue;
    }
    const written = await writeThumbnail(dir, assets, { browser });
    if (written) ok += 1;
    else failed.push(name);
    console.log(`${written ? 'ok  ' : 'fail'} ${name}`);
  }
} finally {
  await browser.close();
}
console.log(`done: ${ok} written, ${skipped.length} without HTML, ${failed.length} failed${failed.length ? ` (${failed.join(', ')})` : ''}`);
