import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

import { chromium as playwrightChromium } from 'playwright-core';

import { expandHome } from './helpers.mjs';
import { cookieOrgExpression, omelette } from './rpc.mjs';

const DEFAULT_PROFILE = '~/.cache/claude-design-mcp/chrome-profile';
const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DESIGN_URL = 'https://claude.ai/design';
const CF_TEXT = /just a moment|checking your browser|attention required|잠시만/i;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const profileDir = () => expandHome(process.env.CLAUDE_DESIGN_PROFILE || DEFAULT_PROFILE);
export const chromeBin = () => process.env.CLAUDE_DESIGN_CHROME || DEFAULT_CHROME;
export const cdpPort = () => Number(process.env.CLAUDE_DESIGN_CDP_PORT || 9377);
export const launchTimeout = () => Number(process.env.CLAUDE_DESIGN_LAUNCH_TIMEOUT_MS || 15_000);
export const readyTimeout = () => Number(process.env.CLAUDE_DESIGN_READY_TIMEOUT_MS || 45_000);

export class NotLoggedInError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotLoggedInError';
  }
}

export class SessionStartError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SessionStartError';
  }
}

export function loginHelp(detail) {
  const suffix = detail ? ` Detail: ${detail}` : '';
  return `Not logged in to Claude Design. Run design_login, then retry. If Chrome cannot start, check CLAUDE_DESIGN_CHROME.${suffix}`;
}

async function fetchJson(url, timeoutMs, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function chromeVersion(port, fetchImpl) {
  try {
    return await fetchJson(`http://127.0.0.1:${port}/json/version`, 500, fetchImpl);
  } catch (error) {
    void error;
    return null;
  }
}

export async function launchChrome({ visible = false, fetchImpl = fetch, spawnImpl = spawn } = {}) {
  const port = cdpPort();
  await mkdir(profileDir(), { recursive: true });
  const hiddenArgs = [
    '--window-position=-2400,-2400',
    '--window-size=1200,840',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ];
  const args = [
    `--user-data-dir=${profileDir()}`,
    `--remote-debugging-port=${port}`,
    '--disable-blink-features=AutomationControlled',
    ...(visible ? ['--new-window'] : hiddenArgs),
    DESIGN_URL,
  ];
  let launchError = null;
  const child = spawnImpl(chromeBin(), args, { detached: true, stdio: 'ignore' });
  child.once('error', (error) => { launchError = error; });
  child.unref();
  const deadline = Date.now() + launchTimeout();
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    const version = await chromeVersion(port, fetchImpl);
    if (version) return version;
    await delay(250);
  }
  if (launchError) throw launchError;
  throw new Error(`Chrome CDP did not open on ${port} within ${launchTimeout()}ms`);
}

function orgFromMe(me) {
  return me?.organizationUuid || me?.orgUuid || me?.organization?.uuid || null;
}

async function probePage(page) {
  let cookieOrg = null;
  try {
    cookieOrg = await page.evaluate(cookieOrgExpression());
    const me = await omelette(page, 'GetMe', {}, cookieOrg);
    const text = String(me?.__text || '');
    const org = cookieOrg || orgFromMe(me);
    if (org && !CF_TEXT.test(text)) return { result: { org, me }, lastError: null };
    return { result: null, lastError: org ? 'Cloudflare interstitial still rendering' : 'GetMe returned no organization uuid' };
  } catch (error) {
    return { result: null, lastError: String(error?.message || error) };
  }
}

async function waitForReady(page, timeoutMs = readyTimeout()) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    const probe = await probePage(page);
    if (probe.result) return probe.result;
    if (probe.lastError) lastError = probe.lastError;
    if (Date.now() >= deadline) {
      const detail = `login required or Cloudflare not cleared in time${lastError ? `; last probe error: ${lastError}` : ''}`;
      throw new NotLoggedInError(loginHelp(detail));
    }
    await delay(2_500);
  }
}

async function pageFromBrowser(browser) {
  const context = browser.contexts()[0] || (await browser.newContext());
  const pages = context.pages();
  const existing = pages.find((page) => String(page.url()).includes('claude.ai'));
  if (existing) {
    if (!String(existing.url()).includes('/design')) await existing.goto(DESIGN_URL, { waitUntil: 'domcontentloaded' });
    return existing;
  }
  const page = await context.newPage();
  await page.goto(DESIGN_URL, { waitUntil: 'domcontentloaded' });
  return page;
}

let cachedSession = null;

// Expose the already-connected CDP browser (if any) so other modules (e.g. preview)
// can open a throwaway page on it instead of launching a separate headless Chrome.
export function getConnectedBrowser() {
  const browser = cachedSession?.browser;
  if (!browser) return null;
  return browser.isConnected?.() === false ? null : browser;
}

function sessionAlive(session) {
  return session.browser.isConnected?.() !== false && session.page.isClosed?.() !== true;
}

export async function ensureSession({ visible = false, force = false, fetchImpl = fetch, chromium = playwrightChromium, connect = null } = {}) {
  if (cachedSession && !force) {
    if (sessionAlive(cachedSession)) return cachedSession;
    cachedSession = null;
  }
  const port = cdpPort();
  try {
    if (!await chromeVersion(port, fetchImpl)) await launchChrome({ visible, fetchImpl });
    const cdpUrl = `http://127.0.0.1:${port}`;
    const browser = connect ? await connect(cdpUrl) : await chromium.connectOverCDP(cdpUrl);
    const page = await pageFromBrowser(browser);
    const ready = await waitForReady(page);
    cachedSession = { browser, page, org: ready.org, me: ready.me };
    browser.once('disconnected', () => {
      if (cachedSession?.browser === browser) cachedSession = null;
    });
    return cachedSession;
  } catch (error) {
    if (error instanceof NotLoggedInError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new SessionStartError(`Chrome/CDP session could not start (port ${port}): ${detail}. Check CLAUDE_DESIGN_CHROME or a conflicting Chrome on this port.`);
  }
}

// Every tool call runs on its own throwaway page: parallel tools used to share the one
// cached session.page, so a second call's navigation ripped the first call's tab away.
export async function withOperationPage(session, fn) {
  const context = session.browser.contexts()[0] || (await session.browser.newContext());
  const page = await context.newPage();
  await page.goto(DESIGN_URL, { waitUntil: 'domcontentloaded' });
  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}

export async function awaitDesignReady(page, projectId) {
  await page.goto(`${DESIGN_URL}/p/${projectId}`, { waitUntil: 'domcontentloaded' });
  const ready = await waitForReady(page);
  await omelette(page, 'GetProjectData', { projectId }, ready.org);
  await page.locator('div.ProseMirror[contenteditable="true"]').first().waitFor({ state: 'visible', timeout: 30_000 });
  return ready;
}
