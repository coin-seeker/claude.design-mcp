import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { chromium as playwrightChromium } from 'playwright-core';

import { decodeToBuffer, expandHome, fileEntriesOf, sanitizeName } from './helpers.mjs';
import { omelette } from './rpc.mjs';
import { chromeBin, getConnectedBrowser } from './session.mjs';

export const previewOut = () => process.env.CLAUDE_DESIGN_DIR || process.cwd();

// Choose the file to render: an explicit path, else index.html, else any .html, else the first file.
export function pickHtmlPath(entries, explicit) {
  if (explicit) return explicit;
  const files = (Array.isArray(entries) ? entries : []).filter((entry) => entry?.type !== 'directory' && entry?.path);
  const found = files.find((entry) => /(?:^|\/)index\.html?$/i.test(entry.path))
    || files.find((entry) => /\.html?$/i.test(entry.path));
  return found?.path || null;
}

async function renderOnPage(page, html, outFile) {
  await page.setContent(String(html), { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForTimeout(400);
  const pageSize = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
  await mkdir(path.dirname(outFile), { recursive: true });
  await page.screenshot({ path: outFile, fullPage: true });
  return pageSize;
}

// Render standalone HTML to a full-page PNG. Reuses the already-connected CDP session
// Chrome when available (a fresh throwaway page — the claude.ai tab/profile is untouched,
// only the new page is closed); otherwise falls back to launching a headless Chrome.
export async function renderHtmlToPng(html, outFile, options = {}) {
  const width = Number(options.width || 1440);
  const height = Number(options.height || 900);
  const sessionBrowser = options.sessionBrowser !== undefined ? options.sessionBrowser : getConnectedBrowser();
  if (sessionBrowser) {
    const page = await sessionBrowser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    try {
      return await renderOnPage(page, html, outFile);
    } finally {
      await page.close().catch(() => {});
    }
  }
  const chromium = options.chromium || playwrightChromium;
  const executablePath = options.executablePath || chromeBin();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    return await renderOnPage(page, html, outFile);
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function previewProject(session, projectId, options = {}, deps = {}) {
  const listFiles = deps.listFiles || ((id) => omelette(session.page, 'ListFiles', { projectId: id, depth: 100, offset: 0 }, session.org));
  const getFile = deps.getFile || ((id, filePath) => omelette(session.page, 'GetFile', { projectId: id, path: filePath }, session.org));
  const render = deps.render || renderHtmlToPng;
  const entries = fileEntriesOf(await listFiles(projectId));
  const target = pickHtmlPath(entries, options.path);
  if (!target) throw new Error('design_preview: no HTML file found to render in project');
  const file = await getFile(projectId, target);
  const html = decodeToBuffer(file.content || '').toString('utf8');
  const baseDir = path.resolve(expandHome(options.out || previewOut()));
  const outFile = path.join(baseDir, `${sanitizeName(String(target).replace(/[\\/]+/g, '-'))}.png`);
  const pageSize = await render(html, outFile, { width: options.width, height: options.height });
  return { projectId, path: target, image: outFile, pageSize };
}
