import { renameSync, rmSync } from 'node:fs';
import path from 'node:path';

import { logEvent } from '../log.mjs';
import { renderProjectToPng } from '../preview-render.mjs';

// claude.ai shipped a `.thumbnail` beside standalone pulls; artifacts pulls have none, so the
// dashboard feed fell back to a live frame per tile. This renders the same static picture.
export const THUMBNAIL_NAME = '.thumbnail';
const VIEWPORT = { width: 1280, height: 800 };
const CLIP = { x: 0, y: 0, ...VIEWPORT };
const ARCHIVED_HTML = / v\d+\.(dc\.)?html$/i;
const KINDS = ['dc-html', 'index-html', 'html', 'archived-html'];

// Mirrors the dashboard's representative-file rule (opencode-dashboard
// src/lib/claude-design-history/artifacts.ts), so the picture shows the document its viewer opens.
function kindOf(relative, hasHtmlWitness) {
  const base = relative.slice(relative.lastIndexOf('/') + 1);
  if (hasHtmlWitness && ARCHIVED_HTML.test(base)) return 'archived-html';
  if (base.endsWith('.dc.html')) return 'dc-html';
  if (base === 'index.html') return 'index-html';
  if (base.toLowerCase().endsWith('.html')) return 'html';
  return null;
}

export function pickThumbnailDocument(relativePaths) {
  const files = [...relativePaths].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const hasHtmlWitness = files.filter((relative) => relative.toLowerCase().endsWith('.html')).length > 1;
  for (const kind of KINDS) {
    const match = files.find((relative) => kindOf(relative, hasHtmlWitness) === kind);
    if (match !== undefined) return match;
  }
  return null;
}

/**
 * Best-effort: renders the representative HTML of `assets` (canonical relative path →
 * `{path, bytes, contentType}`) to `<root>/.thumbnail` (JPEG). Never throws; on any failure a
 * stale thumbnail is removed so it cannot outlive the pull it described. Returns the absolute
 * NFC path, or null.
 */
export async function writeThumbnail(root, assets, { browser, render = renderProjectToPng, timeoutMs = 30_000 } = {}) {
  const target = path.join(root, THUMBNAIL_NAME);
  const tmp = `${target}.jpg`;
  try {
    const document = pickThumbnailDocument(assets.keys());
    if (document === null) {
      rmSync(target, { force: true });
      return null;
    }
    await render(assets, document, tmp, { ...VIEWPORT, clip: CLIP, browser, attemptBudgetMs: timeoutMs });
    renameSync(tmp, target);
    return target.normalize('NFC');
  } catch (error) {
    rmSync(tmp, { force: true });
    rmSync(target, { force: true });
    logEvent('artifacts.thumbnail_failed', { root, error: String(error?.message || error) });
    return null;
  }
}
