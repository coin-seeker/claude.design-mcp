import { closePage, logEvent, pageIdentity } from './log.mjs';
import { createBackgroundDesignPage } from './session.mjs';

const DESIGN_URL = 'https://claude.ai/design';
const OPERATION_PAGE_LEASE_MS = 45 * 60_000;
const heldOperationPages = new WeakMap();
const heldProjectPages = new Map();

function leaseTimeout(ms) {
  let timer;
  const promise = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ source: 'timeout', result: {
      status: 'timeout',
      files: [],
      lastMessageRole: null,
      terminal: true,
    } }), ms);
    timer.unref?.();
  });
  return { promise, clear: () => clearTimeout(timer) };
}

function isLiveUserOnly(result) {
  return result?.terminal !== true
    && result?.lastMessageRole === 'user'
    && (!Array.isArray(result?.files) || result.files.length === 0);
}

export function holdOperationPage(page, completion, reason, options = {}) {
  const state = { closed: false, reason };
  heldOperationPages.set(page, state);
  const pageId = pageIdentity(page);
  const projectId = options.projectId ? String(options.projectId) : null;
  const timeoutMs = Number(options.leaseTimeoutMs ?? process.env.CLAUDE_DESIGN_PAGE_LEASE_MS ?? OPERATION_PAGE_LEASE_MS);
  if (projectId) heldProjectPages.set(projectId, page);
  const timeout = leaseTimeout(timeoutMs);
  logEvent('page.hold', { reason, pageId, projectId, timeoutMs, url: typeof page.url === 'function' ? page.url() : '' });
  const completed = Promise.resolve(completion).then((result) => ({ source: 'completion', result }));
  Promise.race([completed, timeout.promise])
    .then(async (outcome) => {
      if (outcome.source === 'completion' && isLiveUserOnly(outcome.result)) {
        logEvent('page.hold_live', { reason, pageId, projectId, status: outcome.result.status });
        return timeout.promise;
      }
      return outcome;
    })
    .then(
      (outcome) => {
        const result = outcome.result;
        logEvent(outcome.source === 'timeout' ? 'page.hold_timeout' : 'page.hold_complete', {
          reason,
          pageId,
          projectId,
          status: result?.status ?? null,
          files: Array.isArray(result?.files) ? result.files.length : null,
          lastMessageRole: result?.lastMessageRole ?? null,
        });
      },
      (error) => {
        logEvent('page.hold_failed', { reason, pageId, projectId, error: String(error?.message || error) });
      },
    )
    .finally(async () => {
      timeout.clear();
      if (state.closed) return;
      state.closed = true;
      heldOperationPages.delete(page);
      if (projectId && heldProjectPages.get(projectId) === page) heldProjectPages.delete(projectId);
      await closePage(page, reason, { projectId });
    });
}

export function isHeldOperationPage(page) {
  return heldOperationPages.has(page);
}

function heldProjectPage(projectId) {
  const key = String(projectId);
  const page = heldProjectPages.get(key);
  if (!page) return null;
  if (page.isClosed?.() !== true) return page;
  heldProjectPages.delete(key);
  return null;
}

export function hasHeldProjectPage(projectId) {
  return heldProjectPage(projectId) !== null;
}

export function pickRpcPage(pages) {
  return pages.filter((page) => {
    if (page.isClosed?.()) return false;
    try { return new URL(page.url()).origin === 'https://claude.ai'; }
    catch { return false; }
  }).sort((left, right) => {
    const rank = (page) => {
      const pathname = new URL(page.url()).pathname;
      return pathname === '/design' ? 0 : pathname.startsWith('/design/p/') ? 2 : 1;
    };
    return rank(left) - rank(right);
  })[0] ?? null;
}

export async function withRpcPage(session, fn, deps = { createPage: createBackgroundDesignPage }) {
  const excluded = new Set();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const pages = [...new Set([session.page, ...(session.browser.contexts()[0]?.pages() ?? [])])].filter((page) => page && !excluded.has(page));
    const page = pickRpcPage(pages) ?? await deps.createPage(session.browser);
    session.page = page;
    try { return await fn(page); }
    catch (error) {
      if (attempt || !/Execution context was destroyed|Target page, context or browser has been closed|Target closed|frame was detached|has been closed/i.test(String(error?.message ?? error))) throw error;
      excluded.add(page);
    }
  }
}

export async function withOperationPage(session, fn) {
  const context = session.browser.contexts()[0] || (await session.browser.newContext());
  const page = await context.newPage();
  await page.goto(DESIGN_URL, { waitUntil: 'domcontentloaded' });
  let closeReason = 'operation-complete';
  try {
    return await fn(page);
  } catch (error) {
    closeReason = 'operation-error';
    throw error;
  } finally {
    const held = heldOperationPages.get(page);
    if (held) logEvent('page.close_deferred', { reason: held.reason, pageId: pageIdentity(page), url: typeof page.url === 'function' ? page.url() : '' });
    else await closePage(page, closeReason);
  }
}

export async function withProjectOperationPage(session, projectId, fn) {
  const held = heldProjectPage(projectId);
  if (!held) return withOperationPage(session, fn);
  logEvent('page.reuse', {
    pageId: pageIdentity(held),
    projectId: String(projectId),
    url: typeof held.url === 'function' ? held.url() : '',
  });
  return fn(held);
}
