import { fileEntriesOf, generatedFileEntries, lastMessageRoleOf } from './helpers.mjs';
import { logEvent, pageIdentity } from './log.mjs';
import { omelette } from './rpc.mjs';
import { classifyTurnRequest, signatureStable, stabilitySignature } from './turn-classify.mjs';

const ASYNC_HOLD_TIMEOUT_MS = 45 * 60_000;
const MIN_WATCH_MS = 45_000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const responseUrl = (response) => typeof response.url === 'function' ? response.url() : response.url;
const requestUrl = (request) => typeof request.url === 'function' ? request.url() : request.url;
const requestMethod = (request) => typeof request.method === 'function' ? request.method() : request.method;
const responseStatus = (response) => typeof response.status === 'function' ? response.status() : response.status;

async function defaultListFiles(session, projectId) {
  const result = await omelette(session.page, 'ListFiles', { projectId, depth: 100, offset: 0 }, session.org);
  return generatedFileEntries(fileEntriesOf(result));
}

async function defaultLastMessageRole(session, projectId) {
  const result = await omelette(session.page, 'GetProjectData', { projectId }, session.org);
  return lastMessageRoleOf(result);
}

async function sleepWithPage(page, ms) {
  if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(ms);
  else await delay(ms);
}

export async function monitorPendingTurn(session, projectId, options = {}) {
  const listFiles = options.listFiles || defaultListFiles;
  const answerQuestions = options.answerQuestions || (async () => false);
  const getLastMessageRole = options.getLastMessageRole || defaultLastMessageRole;
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
  let lastState = null;
  const pageId = pageIdentity(session.page);
  const onRequest = (request) => {
    const kind = classifyTurnRequest(requestUrl(request));
    if (kind === 'other') return;
    logEvent('turn.monitor_request', { projectId, pageId, kind, method: requestMethod(request), url: requestUrl(request) });
  };
  const onResponse = (response) => {
    const kind = classifyTurnRequest(responseUrl(response));
    if (kind === 'other') return;
    lastActivity = Date.now();
    logEvent('turn.monitor_response', { projectId, pageId, kind, status: responseStatus(response), url: responseUrl(response) });
  };
  const onRequestFailed = (request) => {
    const kind = classifyTurnRequest(requestUrl(request));
    if (kind === 'other') return;
    const failure = typeof request.failure === 'function' ? request.failure() : request.failure;
    logEvent('turn.monitor_request_failed', {
      projectId,
      pageId,
      kind,
      method: requestMethod(request),
      url: requestUrl(request),
      error: String(failure?.errorText || failure || 'request failed'),
    });
  };
  session.page.on('request', onRequest);
  session.page.on('response', onResponse);
  session.page.on('requestfailed', onRequestFailed);
  try {
    for (;;) {
      await sleepWithPage(session.page, pollMs);
      if (await answerQuestions(session.page)) {
        answeredQuestions = true;
        lastActivity = Date.now();
      }
      const entries = await listFiles(session, projectId);
      const lastMessageRole = await getLastMessageRole(session, projectId);
      const signature = stabilitySignature(entries);
      history.push(signature);
      const hasFiles = entries.length > 0;
      const changed = signature !== baseline;
      const now = Date.now();
      const progressed = options.requireChange === false ? hasFiles : changed && hasFiles;
      const state = `${lastMessageRole}:${entries.length}:${signature}`;
      if (state !== lastState) {
        lastState = state;
        logEvent('turn.monitor_state', { projectId, pageId, files: entries.length, lastMessageRole, changed });
      }
      const settled = now - startedAt >= minWatchMs
        && now - lastActivity > quietMs
        && signatureStable(history, stableCycles);
      if (lastMessageRole === 'assistant' && settled && (progressed || !hasFiles)) {
        const status = hasFiles ? 'done' : 'no_output';
        logEvent('turn.monitor_complete', { projectId, pageId, status, files: entries.length, lastMessageRole, answeredQuestions, ms: now - startedAt });
        return { status, files: entries, lastMessageRole, answeredQuestions, terminal: true };
      }
      if (now - startedAt >= timeoutMs) {
        logEvent('turn.monitor_timeout', { projectId, pageId, files: entries.length, lastMessageRole, answeredQuestions, ms: now - startedAt });
        return { status: 'timeout', files: entries, lastMessageRole, answeredQuestions, terminal: true };
      }
    }
  } finally {
    session.page.off('request', onRequest);
    session.page.off('response', onResponse);
    session.page.off('requestfailed', onRequestFailed);
  }
}
