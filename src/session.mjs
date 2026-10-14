import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

import { chromium as playwrightChromium } from 'playwright-core';

import { accountConfig, currentAccount } from './accounts.mjs';
import { closeChrome, headlessEnabled, headlessUserAgent, readChromeMode, writeChromeMode } from './chrome-launch.mjs';
import { whenIdleCloseSettled } from './idle-close.mjs';
import { logEvent } from './log.mjs';
import { cookieOrgExpression, omelette } from './rpc.mjs';
import { designBackend, homeUrl } from './backend.mjs';

export { holdOperationPage, isHeldOperationPage, withOperationPage, withProjectOperationPage, withRpcPage, hasHeldProjectPage } from './operation-pages.mjs';

const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DESIGN_URL = 'https://claude.ai/design';
const CF_TEXT = /just a moment|checking your browser|attention required|잠시만/i;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const profileDir = () => accountConfig(currentAccount()).profile;
export const chromeBin = () => process.env.CLAUDE_DESIGN_CHROME || DEFAULT_CHROME;
export const cdpPort = () => accountConfig(currentAccount()).port;
export const launchTimeout = () => Number(process.env['CLAUDE_DESIGN_LAUNCH_TIMEOUT_MS'] || 15_000);
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

const BACKGROUND_ARGS = [
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
];

// visible = login window; headless (default) = no window/Dock/focus; offscreen = legacy CLAUDE_DESIGN_HEADLESS=0.
async function modeArgs(mode, userAgentImpl) {
  if (mode === 'visible') return ['--new-window'];
  if (mode === 'offscreen') return ['--window-position=-2400,-2400', '--window-size=1200,840', ...BACKGROUND_ARGS];
  // --screen-info replaces headless Chrome's tell-tale 800x600 screen with a laptop-sized one.
  return [
    '--headless=new', `--user-agent=${await userAgentImpl(chromeBin())}`,
    '--screen-info={1440x900}', '--window-size=1200,840', ...BACKGROUND_ARGS,
  ];
}

export async function launchChrome({ visible = false, fetchImpl = fetch, spawnImpl = spawn, userAgentImpl = headlessUserAgent } = {}) {
  const port = cdpPort();
  const profile = profileDir();
  await mkdir(profile, { recursive: true });
  const mode = visible ? 'visible' : headlessEnabled() ? 'headless' : 'offscreen';
  const args = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    '--disable-blink-features=AutomationControlled',
    ...await modeArgs(mode, userAgentImpl),
    homeUrl(),
  ];
  let launchError = null;
  const child = spawnImpl(chromeBin(), args, { detached: true, stdio: 'ignore' });
  child.once('error', (error) => { launchError = error; });
  child.unref();
  const deadline = Date.now() + launchTimeout();
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    const version = await chromeVersion(port, fetchImpl);
    if (version) {
      await writeChromeMode(profile, mode);
      return version;
    }
    await delay(250);
  }
  if (launchError) throw launchError;
  throw new Error(`Chrome CDP did not open on ${port} within ${launchTimeout()}ms`);
}

function orgFromMe(me) {
  return me?.organizationUuid || me?.orgUuid || me?.organization?.uuid || null;
}

export async function probePage(page) {
  let cookieOrg = null;
  try {
    cookieOrg = await page.evaluate(cookieOrgExpression());
    if (designBackend() === 'artifacts') {
      if (!cookieOrg) return { result: null, lastError: 'No organization cookie found' };
      // Lazy import avoids session -> API -> session initialization cycles.
      const { frameRequest } = await import('./artifacts/api.mjs');
      await frameRequest({ page, org: cookieOrg }, 'GET', '/api/frame/types');
      return { result: { org: cookieOrg, me: null }, lastError: null };
    }
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

export async function createBackgroundDesignPage(browser, { timeoutMs = 15_000 } = {}) {
  const cdp = await browser.newBrowserCDPSession();
  let targetId;
  try {
    ({ targetId } = await cdp.send('Target.createTarget', { url: homeUrl(), background: true }));
  } finally {
    await cdp.detach();
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const page of browser.contexts()[0]?.pages() ?? []) {
      const probe = await page.context().newCDPSession(page);
      try {
        const info = await probe.send('Target.getTargetInfo');
        if (info.targetInfo.targetId === targetId) {
          await page.waitForLoadState('domcontentloaded');
          return page;
        }
      } finally {
        await probe.detach();
      }
    }
    await delay(100);
  }
  throw new SessionStartError(`Background Claude Design target ${targetId} did not attach`);
}

export async function pageFromBrowser(browser, deps = { createPage: createBackgroundDesignPage }) {
  const existing = browser.contexts().flatMap((context) => context.pages()).find((page) => {
    try { return !page.isClosed?.() && new URL(page.url()).origin === 'https://claude.ai'; }
    catch { return false; }
  });
  return existing ?? deps.createPage(browser);
}

const cachedSessions = new Map();

function sessionAlive(session) {
  return session.browser.isConnected?.() !== false && session.page.isClosed?.() !== true;
}

const LOGIN_PROBE_MS = 10_000;

function rememberSession(account, { browser, page }, ready) {
  const session = { browser, page, org: ready.org, me: ready.me };
  cachedSessions.set(account, session);
  browser.once('disconnected', () => {
    if (cachedSessions.get(account)?.browser === browser) cachedSessions.delete(account);
  });
  return session;
}

async function readyOrNull(page, timeoutMs) {
  try {
    return await waitForReady(page, timeoutMs);
  } catch (error) {
    if (error instanceof NotLoggedInError) return null;
    throw error;
  }
}

export async function ensureSession({
  visible = false, force = false, fetchImpl = fetch, chromium = playwrightChromium, connect = null,
  spawnImpl = spawn, userAgentImpl = headlessUserAgent, loginProbeMs = LOGIN_PROBE_MS,
} = {}) {
  const account = currentAccount();
  await whenIdleCloseSettled(account);
  const cachedSession = cachedSessions.get(account);
  if (cachedSession && !force) {
    if (sessionAlive(cachedSession)) return cachedSession;
    cachedSessions.delete(account);
  }
  const port = cdpPort();
  const profile = profileDir();
  const isUp = async () => Boolean(await chromeVersion(port, fetchImpl));
  const launch = (launchVisible) => launchChrome({ visible: launchVisible, fetchImpl, spawnImpl, userAgentImpl });
  const attach = async () => {
    const cdpUrl = `http://127.0.0.1:${port}`;
    const connectOptions = { noDefaults: true };
    const browser = connect
      ? await connect(cdpUrl, connectOptions)
      : await chromium.connectOverCDP(cdpUrl, connectOptions);
    return { browser, page: await pageFromBrowser(browser) };
  };
  try {
    let attached = null;
    if (await isUp()) {
      attached = await attach();
      // Login needs a window only when the running headless profile is not signed in.
      if (visible && headlessEnabled() && await readChromeMode(profile) === 'headless') {
        const ready = await readyOrNull(attached.page, loginProbeMs);
        if (ready) return rememberSession(account, attached, ready);
        await closeChrome(attached.browser, { isUp, profile });
        attached = null;
      }
    }
    if (!attached) {
      await launch(visible);
      attached = await attach();
    }
    const ready = await waitForReady(attached.page);
    // A finished login moves the signed-in profile back to headless so the window disappears.
    if (headlessEnabled() && await readChromeMode(profile) === 'visible') {
      await closeChrome(attached.browser, { isUp, profile });
      await launch(false);
      attached = await attach();
      return rememberSession(account, attached, await waitForReady(attached.page));
    }
    return rememberSession(account, attached, ready);
  } catch (error) {
    if (error instanceof NotLoggedInError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new SessionStartError(`Chrome/CDP session could not start (port ${port}): ${detail}. Check CLAUDE_DESIGN_CHROME or a conflicting Chrome on this port.`);
  }
}

const OPERATION_PATH = /^\/(cowork|chat)\/|^\/design\/p\//;

// Idle pages are the background RPC/home tab and browser-internal targets. Operation URLs or any other site
// mean work this process does not track (a CLI run on the same Chrome), so the close is deferred.
function idleEligible(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return true; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;
  return parsed.origin === 'https://claude.ai' && !OPERATION_PATH.test(parsed.pathname);
}

// Runs inside withAccount from the idle scheduler. Never calls ensureSession (which awaits this close).
export async function closeIdleChrome({ fetchImpl = fetch, chromium = playwrightChromium, closeChromeImpl = closeChrome } = {}) {
  const account = currentAccount();
  const port = cdpPort();
  const profile = profileDir();
  const isUp = async () => Boolean(await chromeVersion(port, fetchImpl));
  if (!await isUp()) return { closed: false };
  const cached = cachedSessions.get(account);
  const owned = !(cached && sessionAlive(cached));
  const browser = owned ? await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true }) : cached.browser;
  const urls = browser.contexts().flatMap((context) => context.pages()).map((page) => page.url());
  const busy = urls.filter((url) => !idleEligible(url));
  if (busy.length) {
    logEvent('chrome.idle_close_deferred', { account, port, urls: busy });
    // Disconnects only: Playwright's close() on a CDP-attached browser leaves Chrome running.
    if (owned) await browser.close().catch((error) => logEvent('chrome.idle_disconnect_failed', { account, error: String(error?.message ?? error) }));
    return { deferred: true };
  }
  await closeChromeImpl(browser, { isUp, profile });
  if (cachedSessions.get(account)?.browser === browser) cachedSessions.delete(account);
  logEvent('chrome.idle_close', { account, port, pages: urls.length });
  return { closed: true };
}

export async function awaitDesignReady(page, projectId) {
  let matchesProject = false;
  try {
    matchesProject = new URL(page.url()).pathname === `/design/p/${projectId}`;
  } catch (error) {
    void error;
  }
  if (!matchesProject) await page.goto(`${DESIGN_URL}/p/${projectId}`, { waitUntil: 'domcontentloaded' });
  const ready = await waitForReady(page);
  await omelette(page, 'GetProjectData', { projectId }, ready.org);
  await page.locator('div.ProseMirror[contenteditable="true"]').first().waitFor({ state: 'visible', timeout: 30_000 });
  return ready;
}
