import { fileEntriesOf } from './helpers.mjs';
import { omelette } from './rpc.mjs';
import { awaitDesignReady } from './session.mjs';
import { classifyTurnRequest, signatureStable, stabilitySignature } from './turn-classify.mjs';

const locks = new Map();
const defaultTurnTimeout = () => Number(process.env.CLAUDE_DESIGN_TURN_TIMEOUT_MS || 300_000);
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
  return fileEntriesOf(res);
}

function withProjectLock(projectId, run) {
  const key = String(projectId);
  const previous = locks.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(run);
  const stored = current.finally(() => { if (locks.get(key) === stored) locks.delete(key); });
  locks.set(key, stored);
  return stored;
}

async function submitPrompt(page, prompt) {
  const editor = page.locator('div.ProseMirror[contenteditable="true"]').first();
  await editor.click();
  await page.keyboard.insertText(prompt);
  await sleepWithPage(page, 300);
  try { await page.locator('[data-testid="chat-send-button"]').first().click({ timeout: 3_000 }); }
  catch (error) { void error; await page.keyboard.press('Enter'); }
}

// ONE attempt to clear a clarifying-questions form (AI-generated AFTER the prompt:
// option groups each with "Decide for me", then a "Continue" that starts generation).
export async function tryAnswerQuestions(page) {
  const cont = page.locator('button:has-text("Continue")').first();
  let visible = false;
  try { visible = (await cont.count()) > 0 && await cont.isVisible(); } catch { return false; }
  if (!visible) return false;
  const decide = await page.locator('button:has-text("Decide for me")').all().catch(() => []);
  for (const button of decide) {
    try { await button.click({ timeout: 1_500 }); await sleepWithPage(page, 200); } catch { /* group may re-render */ }
  }
  try { await page.locator('button:has-text("Continue")').first().click({ timeout: 3_000 }); return true; } catch { return false; }
}

async function runUnlocked(session, projectId, prompt, options) {
  const startedAt = Date.now();
  const timeoutMs = Number(options.timeoutMs || defaultTurnTimeout());
  const inactivityMs = Number(options.inactivityMs ?? 45_000);
  const pollMs = Number(options.pollIntervalMs ?? 2_000);
  const stableCycles = Number(options.stableCycles || 3);
  const ready = options.awaitReady || awaitDesignReady;
  const listFiles = options.listFiles || defaultListFiles;
  const answerQuestions = options.answerQuestions || tryAnswerQuestions;

  let released = false;
  let lastActivity = Date.now();
  const handler = (response) => {
    const kind = classifyTurnRequest(responseUrl(response));
    if (kind === 'chat' || kind === 'renew') lastActivity = Date.now();
    if (kind === 'release' && responseStatus(response) < 300) released = true;
  };

  try {
    await ready(session.page, projectId);
    // Snapshot the file tree BEFORE submit so iterate waits for a real change
    // (not the pre-existing files); for create the baseline is empty.
    const baseline = stabilitySignature(await listFiles(session, projectId).catch(() => []));
    session.page.on('response', handler);
    await submitPrompt(session.page, String(prompt));

    const history = [];
    const deadline = Date.now() + timeoutMs;
    let stable = false;
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
      if (changed && hasFiles && (released || signatureStable(history, stableCycles))) { stable = true; break; }
      const now = Date.now();
      if (changed && hasFiles && now - lastActivity > inactivityMs) { stable = signatureStable(history, 2); break; }
      if (now >= deadline) break;
    }
    return { released, stable, hasFiles, changed, answered, ms: Date.now() - startedAt };
  } finally {
    if (typeof session.page.off === 'function') session.page.off('response', handler);
  }
}

export function runGenerateTurn(session, projectId, prompt, options = {}) {
  return withProjectLock(projectId, () => runUnlocked(session, projectId, prompt, options));
}
