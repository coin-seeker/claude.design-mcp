import { fileEntriesOf, generatedFileEntries } from './helpers.mjs';
import { logEvent } from './log.mjs';
import { omelette } from './rpc.mjs';
import { classifyTurnRequest, signatureStable, stabilitySignature } from './turn-classify.mjs';

const ASYNC_HOLD_TIMEOUT_MS = 45 * 60_000;
const MIN_WATCH_MS = 45_000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const responseUrl = (response) => typeof response.url === 'function' ? response.url() : response.url;

async function defaultListFiles(session, projectId) {
  const result = await omelette(session.page, 'ListFiles', { projectId, depth: 100, offset: 0 }, session.org);
  return generatedFileEntries(fileEntriesOf(result));
}

async function sleepWithPage(page, ms) {
  if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(ms);
  else await delay(ms);
}

export async function monitorPendingTurn(session, projectId, options = {}) {
  const listFiles = options.listFiles || defaultListFiles;
  const answerQuestions = options.answerQuestions || (async () => false);
  const pollMs = Number(options.pollIntervalMs ?? 2_000);
  const quietMs = Number(options.quietMs ?? process.env.CLAUDE_DESIGN_QUIET_MS ?? 20_000);
  const stableCycles = Number(options.stableCycles || 3);
  const timeoutMs = Number(options.timeoutMs ?? process.env.CLAUDE_DESIGN_ASYNC_HOLD_MS ?? ASYNC_HOLD_TIMEOUT_MS);
  const minWatchMs = Number(options.minWatchMs ?? MIN_WATCH_MS);
  const startedAt = Date.now();
  const baseline = options.baselineSignature ?? stabilitySignature(await listFiles(session, projectId));
  const history = [];
  let lastActivity = Date.now();
  let answeredQuestions = false;
  const onResponse = (response) => {
    const kind = classifyTurnRequest(responseUrl(response));
    if (kind === 'chat' || kind === 'renew' || kind === 'release') lastActivity = Date.now();
  };
  session.page.on('response', onResponse);
  try {
    for (;;) {
      await sleepWithPage(session.page, pollMs);
      if (await answerQuestions(session.page)) {
        answeredQuestions = true;
        lastActivity = Date.now();
      }
      const entries = await listFiles(session, projectId);
      const signature = stabilitySignature(entries);
      history.push(signature);
      const hasFiles = entries.length > 0;
      const changed = signature !== baseline;
      const now = Date.now();
      const progressed = options.requireChange === false ? hasFiles : changed && hasFiles;
      if (progressed && now - startedAt >= minWatchMs && now - lastActivity > quietMs && signatureStable(history, stableCycles)) {
        logEvent('turn.monitor_complete', { projectId, files: entries.length, answeredQuestions, ms: now - startedAt });
        return { status: 'done', files: entries, answeredQuestions };
      }
      if (now - startedAt >= timeoutMs) {
        logEvent('turn.monitor_timeout', { projectId, files: entries.length, answeredQuestions, ms: now - startedAt });
        return { status: 'timeout', files: entries, answeredQuestions };
      }
    }
  } finally {
    session.page.off('response', onResponse);
  }
}
