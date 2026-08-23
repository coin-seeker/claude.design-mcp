import fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { chromium as playwrightChromium } from 'playwright-core';

import { capturePlan, normalizeViewport } from './preview-capture.mjs';
import { closePage, logEvent } from './log.mjs';
import { createPreviewRoute, encodedProjectUrl, missingAssetsError } from './preview-route.mjs';
import { chromeBin } from './session.mjs';

const MAX_CLOSE_MS = 5_000;
let invocationCounter = 0;

function errorMessage(error) {
  return String(error?.message || error);
}

function tmpPath(outFile, attemptNumber) {
  invocationCounter += 1;
  const extension = path.extname(outFile);
  const stem = extension ? outFile.slice(0, -extension.length) : outFile;
  return `${stem}.tmp-${process.pid}-${invocationCounter}-${attemptNumber}${extension || '.png'}`;
}

function removeTmp(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch (error) {
    logEvent('preview.tmp_remove_failed', { path: filePath, error: errorMessage(error) });
  }
}

async function boundedClose(label, close, remaining, fields) {
  const timeoutMs = Math.max(0, Math.min(MAX_CLOSE_MS, remaining()));
  const closePromise = Promise.resolve().then(close).then(() => 'closed', (error) => {
    logEvent(`${label}.close_failed`, { ...fields, error: errorMessage(error) });
    return 'failed';
  });
  if (timeoutMs < 1) {
    logEvent(`${label}.close_abandoned`, { ...fields, reason: 'deadline-exhausted' });
    void closePromise;
    return;
  }
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    const result = await Promise.race([
      closePromise,
      timeout,
    ]);
    if (result === 'timeout') logEvent(`${label}.close_abandoned`, { ...fields, reason: 'bounded-timeout' });
  } finally {
    clearTimeout(timer);
  }
}

function attemptTimeoutError(attemptBudgetMs) {
  const error = new Error(`design_preview: render attempt timed out after ${Math.max(1, Math.floor(attemptBudgetMs))}ms`);
  error.previewAttemptWatchdog = true;
  return error;
}

function createAttemptState(attemptBudgetMs, outerDeadline) {
  const started = performance.now();
  const remaining = () => Math.min(
    outerDeadline?.remaining?.() ?? Number.POSITIVE_INFINITY,
    attemptBudgetMs - (performance.now() - started),
  );
  return {
    attemptState: 'running',
    watchdogFired: false,
    remaining,
    claim(next) {
      if (this.attemptState !== 'running') return false;
      this.attemptState = next;
      return true;
    },
  };
}

function assertRunning(state) {
  if (state.attemptState !== 'running' || state.remaining() <= 0) {
    throw attemptTimeoutError(0);
  }
}

function screenshotOptions(filePath, plan) {
  if (plan.fullPage) return { path: filePath, fullPage: true };
  return { path: filePath, fullPage: true, clip: plan.clip };
}

async function waitForFonts(page, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); });
  try {
    await Promise.race([
      Promise.resolve(page.evaluate(() => document.fonts.ready)).catch(() => undefined),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function renderProjectToPng(assets, targetPath, outFile, options = {}) {
  const viewport = normalizeViewport({ width: options.width, height: options.height });
  const attemptNumber = Number(options.attemptNumber || 1);
  const attemptBudgetMs = Math.max(1, Number(options.attemptBudgetMs ?? options.timeoutMs ?? 35_000));
  const state = createAttemptState(attemptBudgetMs, options.dl);
  const tmpFile = tmpPath(outFile, attemptNumber);
  const targetUrl = encodedProjectUrl(targetPath);
  const fatalMissing = new Set();
  const missingAssets = new Set();
  const providedBrowser = options.sessionBrowser || options.browser || null;
  const chromium = options.chromium || playwrightChromium;
  let browser = providedBrowser;
  let context = null;
  let page = null;
  let contextClose = null;
  let browserClose = null;
  let closeReason = 'preview-complete';

  const closeOwnedContext = () => {
    if (!context) return Promise.resolve();
    contextClose ||= boundedClose('context', () => {
      logEvent('context.close', { reason: closeReason });
      return context.close();
    }, options.dl?.remaining || state.remaining, { reason: closeReason });
    return contextClose;
  };
  const closeFallbackBrowser = () => {
    if (!browser || providedBrowser) return Promise.resolve();
    browserClose ||= boundedClose('browser', () => {
      logEvent('browser.close', { reason: closeReason });
      return browser.close();
    }, options.dl?.remaining || state.remaining, { reason: closeReason });
    return browserClose;
  };
  const cleanup = async () => {
    await closeOwnedContext();
    await closeFallbackBrowser();
  };

  let rejectWatchdog;
  const watchdogRejection = new Promise((_, reject) => { rejectWatchdog = reject; });
  const cancel = (error, watchdogFired = false) => {
    if (!state.claim('cancelled')) return false;
    state.watchdogFired = watchdogFired;
    closeReason = 'preview-error';
    Promise.resolve().then(cleanup).finally(() => {
      removeTmp(tmpFile);
      rejectWatchdog(error);
    });
    return true;
  };
  const controller = { state, cancel };
  options.setActiveAttempt?.(controller);
  const watchdog = setTimeout(() => cancel(attemptTimeoutError(attemptBudgetMs), true), attemptBudgetMs);

  const renderPromise = (async () => {
    if (!browser) {
      browser = await chromium.launch({ executablePath: options.executablePath || chromeBin(), headless: true });
      if (state.attemptState === 'cancelled') {
        await closeFallbackBrowser();
        throw attemptTimeoutError(attemptBudgetMs);
      }
    }

    context = await browser.newContext({ viewport, deviceScaleFactor: 1, serviceWorkers: 'block' });
    if (state.attemptState === 'cancelled') {
      await closeOwnedContext();
      await closeFallbackBrowser();
      throw attemptTimeoutError(attemptBudgetMs);
    }

    await context.route('**/*', createPreviewRoute({
      assets,
      targetPath,
      targetUrl,
      page: () => page,
      fatalMissing,
      missingAssets,
    }));
    assertRunning(state);

    page = await context.newPage();
    if (state.attemptState === 'cancelled') {
      await boundedClose('page', () => closePage(page, closeReason), options.dl?.remaining || state.remaining, { reason: closeReason });
      throw attemptTimeoutError(attemptBudgetMs);
    }
    assertRunning(state);

    await page.goto(targetUrl, {
      waitUntil: 'networkidle',
      timeout: Math.max(1, Math.floor(state.remaining())),
    });
    assertRunning(state);

    const fontWaitMs = Math.max(0, Math.min(5_000, state.remaining()));
    if (fontWaitMs > 0) await waitForFonts(page, fontWaitMs);
    assertRunning(state);

    await page.waitForTimeout(400);
    assertRunning(state);
    const pageSize = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
    assertRunning(state);
    if (fatalMissing.size) throw missingAssetsError(fatalMissing);
    const plan = capturePlan(pageSize, viewport);

    await mkdir(path.dirname(outFile), { recursive: true });
    assertRunning(state);
    assertRunning(state);
    await page.screenshot(screenshotOptions(tmpFile, plan));
    if (fatalMissing.size) throw missingAssetsError(fatalMissing);
    if (state.remaining() <= 0 || state.watchdogFired) throw attemptTimeoutError(attemptBudgetMs);
    if (!state.claim('committing')) throw attemptTimeoutError(attemptBudgetMs);
    fs.renameSync(tmpFile, outFile);
    return {
      pageSize,
      capturedSize: plan.capturedSize,
      truncated: plan.truncated,
      missingAssets: [...missingAssets],
    };
  })();

  const observedRender = renderPromise.finally(() => {
    if (state.attemptState !== 'committing') removeTmp(tmpFile);
  });

  try {
    return await Promise.race([observedRender, watchdogRejection]);
  } catch (error) {
    closeReason = 'preview-error';
    if (state.attemptState === 'running') state.claim('cancelled');
    await cleanup();
    removeTmp(tmpFile);
    throw error;
  } finally {
    clearTimeout(watchdog);
    options.setActiveAttempt?.(null);
    await cleanup();
  }
}
