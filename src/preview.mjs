import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { chromium as playwrightChromium } from 'playwright-core';

import { isRendererLossError } from './errors.mjs';
import { expandHome, sanitizeName } from './helpers.mjs';
import {
  canonicalMapKey,
  fetchProjectAssets,
  listProjectFilesComplete,
} from './preview-assets.mjs';
import { renderProjectToPng } from './preview-render.mjs';
import { omelette } from './rpc.mjs';
import { chromeBin, getConnectedBrowser } from './session.mjs';

export { renderProjectToPng } from './preview-render.mjs';

export const previewOut = () => process.env.CLAUDE_DESIGN_DIR || process.cwd();
export const PREVIEW_TIMEOUT_MS = 90_000;

// Choose the file to render: an explicit path, else index.html, else any .html, else the first file.
export function pickHtmlPath(entries, explicit) {
  if (explicit) return explicit;
  const files = (Array.isArray(entries) ? entries : []).filter((entry) => entry?.type !== 'directory' && entry?.path);
  const found = files.find((entry) => /(?:^|\/)index\.html?$/i.test(entry.path))
    || files.find((entry) => /\.html?$/i.test(entry.path));
  return found?.path || null;
}

function timeoutLabel(ms) {
  return ms >= 1_000 ? `${Math.round(ms / 1_000)}s` : `${ms}ms`;
}

function deadlineError(timeoutMs) {
  return new Error(`design_preview: render timed out after ${timeoutLabel(timeoutMs)}`);
}

function createDeadline(timeoutMs, cancel, now = () => performance.now()) {
  const start = now();
  const error = deadlineError(timeoutMs);
  let activeAttempt = null;
  let rejectSignal;
  const signal = new Promise((_, reject) => { rejectSignal = reject; });
  const dl = {
    start,
    total: timeoutMs,
    signal,
    error,
    remaining: () => Math.max(0, timeoutMs - (now() - start)),
    setActiveAttempt(attempt) {
      activeAttempt = attempt;
      if (attempt && cancel.cancelled) attempt.cancel(error);
    },
  };
  const timer = setTimeout(() => {
    cancel.cancelled = true;
    activeAttempt?.cancel(error);
    rejectSignal(error);
  }, Math.max(0, timeoutMs));
  dl.dispose = () => clearTimeout(timer);
  return dl;
}

function assertDeadline(dl) {
  if (dl.remaining() < 1) throw dl.error;
}

function rpcBound(dl) {
  const timeoutMs = Math.floor(Math.min(30_000, dl.remaining()));
  if (timeoutMs < 1) throw dl.error;
  return timeoutMs;
}

let sessionCaptureTail = Promise.resolve();

async function withSessionCapture(dl, run) {
  let release;
  const turn = new Promise((resolve) => { release = resolve; });
  const predecessor = sessionCaptureTail.then(() => undefined, () => undefined);
  sessionCaptureTail = predecessor.then(() => turn, () => turn);
  let abandoned = false;
  const acquisition = predecessor.then(() => {
    if (abandoned || dl.remaining() < 1) {
      release();
      return null;
    }
    return release;
  });

  let acquiredRelease;
  try {
    acquiredRelease = await Promise.race([acquisition, dl.signal]);
  } catch (error) {
    abandoned = true;
    throw error;
  }
  if (!acquiredRelease) throw dl.error;
  try {
    assertDeadline(dl);
    return await run();
  } finally {
    acquiredRelease();
  }
}

async function invokeRender(render, assets, targetPath, outFile, options, dl) {
  const operation = Promise.resolve().then(() => render(assets, targetPath, outFile, options));
  if (render === renderProjectToPng) return operation;
  return Promise.race([operation, dl.signal]);
}

function renderOptions(options, deps, dl, attemptNumber, attemptBudgetMs, sessionBrowser) {
  return {
    width: options.width,
    height: options.height,
    sessionBrowser,
    chromium: deps.chromium || playwrightChromium,
    executablePath: deps.executablePath || chromeBin(),
    attemptNumber,
    attemptBudgetMs,
    dl,
    setActiveAttempt: (attempt) => dl.setActiveAttempt(attempt),
  };
}

function combinedRenderError(firstError, secondError) {
  return new Error(`design_preview: session render failed: ${String(firstError?.message || firstError)}; headless retry failed: ${String(secondError?.message || secondError)}`);
}

async function renderWithRetry(assets, targetPath, outFile, options, deps, dl) {
  const render = deps.render || renderProjectToPng;
  const sessionBrowser = deps.sessionBrowser !== undefined ? deps.sessionBrowser : getConnectedBrowser();
  if (!sessionBrowser) {
    assertDeadline(dl);
    return invokeRender(
      render,
      assets,
      targetPath,
      outFile,
      renderOptions(options, deps, dl, 1, dl.remaining(), null),
      dl,
    );
  }

  let firstError;
  try {
    return await withSessionCapture(dl, () => invokeRender(
      render,
      assets,
      targetPath,
      outFile,
      renderOptions(options, deps, dl, 1, Math.min(dl.remaining(), deps.sessionAttemptMs ?? 35_000), sessionBrowser),
      dl,
    ));
  } catch (error) {
    firstError = error;
  }

  const retryable = isRendererLossError(firstError) || firstError?.previewAttemptWatchdog === true;
  if (!retryable || dl.remaining() < 10_000) throw firstError;
  try {
    return await invokeRender(
      render,
      assets,
      targetPath,
      outFile,
      renderOptions(options, deps, dl, 2, dl.remaining(), null),
      dl,
    );
  } catch (secondError) {
    throw combinedRenderError(firstError, secondError);
  }
}

export async function previewProject(session, projectId, options = {}, deps = {}) {
  const timeoutMs = Number(deps.timeoutMs ?? PREVIEW_TIMEOUT_MS);
  const cancel = { cancelled: false };
  const dl = createDeadline(timeoutMs, cancel, deps.now);
  const listPage = deps.listPage || ((id, offset) => omelette(
    session.page,
    'ListFiles',
    { projectId: id, depth: 100, offset },
    session.org,
    { timeoutMs: rpcBound(dl) },
  ));
  const getFile = deps.getFile || ((id, filePath) => omelette(
    session.page,
    'GetFile',
    { projectId: id, path: filePath },
    session.org,
    { timeoutMs: rpcBound(dl) },
  ));

  try {
    assertDeadline(dl);
    const entries = await Promise.race([
      listProjectFilesComplete(session, projectId, { listPage, cancel, remaining: dl.remaining }),
      dl.signal,
    ]);
    assertDeadline(dl);
    const targetPath = pickHtmlPath(entries, options.path);
    if (!targetPath) throw new Error('design_preview: no HTML file found to render in project');
    const requiredKey = canonicalMapKey(targetPath);
    const listedTarget = entries.find((entry) => entry?.type !== 'directory' && entry?.path && canonicalMapKey(entry.path) === requiredKey);
    if (!listedTarget) throw new Error(`design_preview: target HTML not found in project listing: ${targetPath}`);

    assertDeadline(dl);
    const fetched = await Promise.race([
      fetchProjectAssets(session, projectId, entries, {
        getFile,
        cancel,
        remaining: dl.remaining,
        options: { required: targetPath },
      }),
      dl.signal,
    ]);
    assertDeadline(dl);

    const baseDir = path.resolve(expandHome(options.out || previewOut()));
    const outDir = options.out ? baseDir : path.join(baseDir, sanitizeName(options.projectName || projectId));
    const outFile = path.join(outDir, `${sanitizeName(String(targetPath).replace(/[\\/]+/g, '-'))}.png`);
    const rendered = await renderWithRetry(fetched.assets, targetPath, outFile, options, deps, dl);
    return {
      projectId,
      path: String(targetPath).normalize('NFC'),
      image: outFile.normalize('NFC'),
      pageSize: rendered.pageSize,
      capturedSize: rendered.capturedSize,
      truncated: rendered.truncated,
      ...(rendered.missingAssets?.length ? { missingAssets: rendered.missingAssets } : {}),
    };
  } finally {
    cancel.cancelled = true;
    dl.dispose();
  }
}
