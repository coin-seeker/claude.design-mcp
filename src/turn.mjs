import { fileEntriesOf, generatedFileEntries } from './helpers.mjs';
import { omelette } from './rpc.mjs';
import { awaitDesignReady, holdOperationPage } from './session.mjs';
import { classifyTurnRequest, signatureStable, stabilitySignature } from './turn-classify.mjs';
import { isPageError } from './errors.mjs';
import { logEvent } from './log.mjs';
import { observeTurnAction } from './turn-network.mjs';
import { monitorPendingTurn } from './pending-monitor.mjs';

const locks = new Map();
const SUBMIT_TIMEOUT_MS = 30_000;
const TURN_START_TIMEOUT_MS = 15_000;
const defaultTurnTimeout = () => Number(process.env['CLAUDE_DESIGN_TURN_TIMEOUT_MS'] || 300_000);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const responseStatus = (r) => (typeof r.status === 'function' ? r.status() : r.status);
const responseUrl = (r) => (typeof r.url === 'function' ? r.url() : r.url);

async function sleepWithPage(page, ms) {
  if (ms <= 0) return;
  if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(ms);
  else await delay(ms);
}

async function defaultListFiles(session, projectId) {
  const res = await omelette(session.page, 'ListFiles', { projectId, depth: 100, offset: 0 }, session.org);
  return generatedFileEntries(fileEntriesOf(res));
}

function withProjectLock(projectId, run) {
  const key = String(projectId);
  const previous = locks.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(run);
  const stored = current.finally(() => { if (locks.get(key) === stored) locks.delete(key); });
  locks.set(key, stored);
  return stored;
}

async function submitPrompt(page, prompt, timeoutMs) {
  await observeTurnAction(page, async () => {
    const targetUrl = typeof page.url === 'function' ? page.url() : '';
    logEvent('turn.submit_target', { url: targetUrl });
    const editor = page.locator('div.ProseMirror[contenteditable="true"]').first();
    await editor.click();
    await page.keyboard.insertText(prompt);
    await sleepWithPage(page, 300);
    const sendButton = page.locator('[data-testid="chat-send-button"]').first();
    const enabled = await sendButton.isEnabled();
    logEvent('turn.send_button_state', { enabled, url: targetUrl });
    try {
      await sendButton.click({ timeout: 3_000 });
    } catch (error) {
      logEvent('turn.send_button_fallback', { error: String(error?.message || error), url: targetUrl });
      await page.keyboard.press('Enter');
    }
  }, {
    kinds: ['chat'],
    postOnly: true,
    requireResponse: true,
    timeoutMs,
    requestTimeoutMessage: `Chat POST was not observed within ${timeoutMs}ms`,
    responseTimeoutMessage: `Chat response was not observed within ${timeoutMs}ms`,
  });
}

// ONE attempt to clear a clarifying-questions form (AI-generated AFTER the prompt:
// option groups each with "Decide for me", then a "Continue" that starts generation).
export async function tryAnswerQuestions(page, options = {}) {
  const cont = page.locator('button:has-text("Continue")').first();
  let visible = false;
  try { visible = (await cont.count()) > 0 && await cont.isVisible(); }
  catch (error) {
    if (isPageError(error)) throw error;
    return false;
  }
  if (!visible) return false;
  const decide = await page.locator('button:has-text("Decide for me")').all().catch((error) => {
    if (isPageError(error)) throw error;
    return [];
  });
  for (const button of decide) {
    try { await button.click({ timeout: 1_500 }); await sleepWithPage(page, 200); }
    catch (error) {
      if (isPageError(error)) throw error;
      // group may re-render
    }
  }
  try {
    await observeTurnAction(page, async () => {
      logEvent('turn.continue_click', { url: typeof page.url === 'function' ? page.url() : '' });
      await page.locator('button:has-text("Continue")').first().click({ timeout: 3_000 });
    }, {
      kinds: ['chat', 'renew'],
      postOnly: false,
      requireResponse: false,
      timeoutMs: Number(options.turnStartTimeoutMs ?? TURN_START_TIMEOUT_MS),
      requestTimeoutMessage: 'Continue follow-up Chat or RenewTurn was not observed',
    });
    return true;
  }
  catch (error) {
    if (isPageError(error)) throw error;
    logEvent('turn.continue_not_started', { error: String(error?.message || error) });
    return false;
  }
}

async function runUnlocked(session, projectId, prompt, options) {
  const startedAt = Date.now();
  const timeoutMs = Number(options.timeoutMs || defaultTurnTimeout());
  const quietMs = Number(options.quietMs ?? process.env.CLAUDE_DESIGN_QUIET_MS ?? 20_000);
  const pollMs = Number(options.pollIntervalMs ?? 2_000);
  const stableCycles = Number(options.stableCycles || 3);
  const ready = options.awaitReady || awaitDesignReady;
  const listFiles = options.listFiles || defaultListFiles;
  const answerQuestions = options.answerQuestions || tryAnswerQuestions;
  const monitorPending = options.monitorPending || monitorPendingTurn;
  const holdPage = options.holdPage || holdOperationPage;
  const submitTimeoutMs = Number(options.submitTimeoutMs ?? SUBMIT_TIMEOUT_MS);
  // Composer preparation (e.g. the design-system picker) has to run AFTER ready() navigates and
  // BEFORE the prompt goes in: the navigation would otherwise discard the composer selection.
  const prepareComposer = options.beforeSubmit || (async () => {});

  if (options.wait === false) {
    let baselineSignature;
    await withProjectLock(projectId, async () => {
      await ready(session.page, projectId);
      baselineSignature = stabilitySignature(await listFiles(session, projectId));
      await prepareComposer(session.page);
      await submitPrompt(session.page, String(prompt), submitTimeoutMs);
    });
    const completion = monitorPending(session, projectId, {
      answerQuestions,
      baselineSignature,
      listFiles,
      pollIntervalMs: pollMs,
      quietMs,
      stableCycles,
    });
    holdPage(session.page, completion, 'async-turn-finished', { projectId });
    return { submitted: true, pending: true };
  }

  let released = false;
  let lastActivity = Date.now();
  const handler = (response) => {
    const kind = classifyTurnRequest(responseUrl(response));
    // Chat / RenewTurn keepalives / ReleaseTurn all mark the turn as alive; sustained silence = finished.
    if (kind === 'chat' || kind === 'renew' || kind === 'release') lastActivity = Date.now();
    if (kind === 'release' && responseStatus(response) < 300) released = true;
  };

  try {
    await ready(session.page, projectId);
    // Snapshot the file tree BEFORE submit so iterate waits for a real change
    // (not the pre-existing files); for create the baseline is empty.
    const baseline = stabilitySignature(await listFiles(session, projectId).catch(() => []));
    session.page.on('response', handler);
    await prepareComposer(session.page);
    await submitPrompt(session.page, String(prompt), submitTimeoutMs);

    const history = [];
    const deadline = Date.now() + timeoutMs;
    let stable = false;
    let timedOut = false;
    let hasFiles = false;
    let changed = false;
    let answered = false;
    for (;;) {
      await sleepWithPage(session.page, pollMs);
      // Answer the clarifying questions whenever the form appears (it is generated
      // a few-30s after submit); after Continue the real design generation starts.
      if (!answered && await answerQuestions(session.page)) { answered = true; released = false; lastActivity = Date.now(); }
      const entries = await listFiles(session, projectId).catch(() => []);
      const sig = stabilitySignature(entries);
      hasFiles = entries.length > 0;
      if (sig !== baseline) changed = true;
      history.push(sig);
      // Finish only when the design files have SETTLED and the turn network has gone QUIET.
      // claude.ai keeps a turn alive with RenewTurn keepalives ~every 10s and may split a large
      // design across several continuation turns; demanding >quietMs of silence (no Chat / RenewTurn
      // / ReleaseTurn) means we end only after the FINAL turn — never mid-burst, never between
      // continuations, never racing the ReleaseTurn (the bugs that returned a partial design).
      const now = Date.now();
      if (changed && hasFiles && now - lastActivity > quietMs && signatureStable(history, stableCycles)) { stable = true; break; }
      if (now >= deadline) { timedOut = true; break; }
    }
    return {
      released, stable, hasFiles, changed, answered, ms: Date.now() - startedAt,
      // Only present on the deadline path — a normal completion must NOT carry timedOut:false.
      ...(timedOut ? { timedOut: true } : {}),
    };
  } finally {
    if (typeof session.page.off === 'function') session.page.off('response', handler);
  }
}

export function runGenerateTurn(session, projectId, prompt, options = {}) {
  if (options.wait === false) return runUnlocked(session, projectId, prompt, options);
  return withProjectLock(projectId, () => runUnlocked(session, projectId, prompt, options));
}
