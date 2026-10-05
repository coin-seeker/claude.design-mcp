import { decodeProjectData, fileEntriesOf, generatedFileEntries, turnStateOf } from './helpers.mjs';
import { logEvent, pageIdentity } from './log.mjs';
import { omelette } from './rpc.mjs';
import { classifyTurnRequest, signatureStable, stabilitySignature } from './turn-classify.mjs';

const ASYNC_HOLD_TIMEOUT_MS = 45 * 60_000;
const MIN_WATCH_MS = 45_000;
// ready_for_verification starts a background check that runs inside this tab; closing the tab before it
// reports back leaves claude.ai with "The background check didn't finish". Observed reports land in 19-81s.
const VERIFY_GRACE_MS = 5 * 60_000;
const MAX_TRANSIENT_ERRORS = 10;
const TRANSIENT_ERROR = /AbortError|TimeoutError|timed out|Execution context was destroyed|frame was detached/i;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const responseUrl = (response) => typeof response.url === 'function' ? response.url() : response.url;
const requestUrl = (request) => typeof request.url === 'function' ? request.url() : request.url;
const requestMethod = (request) => typeof request.method === 'function' ? request.method() : request.method;
const responseStatus = (response) => typeof response.status === 'function' ? response.status() : response.status;

async function defaultListFiles(session, projectId) {
  const result = await omelette(session.page, 'ListFiles', { projectId, depth: 100, offset: 0 }, session.org);
  return generatedFileEntries(fileEntriesOf(result));
}

async function defaultTurnState(session, projectId) {
  return turnStateOf(decodeProjectData(await omelette(session.page, 'GetProjectData', { projectId }, session.org)));
}

function turnStateReader(options) {
  if (options.getTurnState) return options.getTurnState;
  if (options.getLastMessageRole) {
    return async (session, projectId) => ({ role: await options.getLastMessageRole(session, projectId), cutOff: false, verificationPending: false, lastAt: null });
  }
  return defaultTurnState;
}

async function sleepWithPage(page, ms) {
  if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(ms);
  else await delay(ms);
}

export async function monitorPendingTurn(session, projectId, options = {}) {
  const listFiles = options.listFiles || defaultListFiles;
  const answerQuestions = options.answerQuestions || (async () => false);
  const getTurnState = turnStateReader(options);
  const verifyGraceMs = Number(options.verifyGraceMs ?? process.env.CLAUDE_DESIGN_VERIFY_GRACE_MS ?? VERIFY_GRACE_MS);
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
  let transientErrors = 0;
  let verifyWaitLogged = false;
  try {
    for (;;) {
      await sleepWithPage(session.page, pollMs);
      if (await answerQuestions(session.page)) {
        answeredQuestions = true;
        lastActivity = Date.now();
      }
      let entries;
      let turn;
      try {
        entries = await listFiles(session, projectId);
        turn = await getTurnState(session, projectId);
        transientErrors = 0;
      } catch (error) {
        // A busy tab can time out an RPC; giving up here would close the tab mid-generation.
        if (!TRANSIENT_ERROR.test(String(error?.message ?? error)) || ++transientErrors > MAX_TRANSIENT_ERRORS) throw error;
        logEvent('turn.monitor_transient', { projectId, pageId, attempt: transientErrors, error: String(error?.message || error) });
        continue;
      }
      const lastMessageRole = turn.role;
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
      if (lastMessageRole === 'assistant' && settled && turn.cutOff) {
        logEvent('turn.monitor_complete', { projectId, pageId, status: 'no_output', cutOff: true, files: entries.length, lastMessageRole, answeredQuestions, ms: now - startedAt });
        return { status: 'no_output', cutOff: true, files: entries, lastMessageRole, answeredQuestions, terminal: true };
      }
      const verifying = turn.verificationPending && now - (turn.lastAt ?? startedAt) < verifyGraceMs;
      if (lastMessageRole === 'assistant' && settled && verifying) {
        if (!verifyWaitLogged) logEvent('turn.monitor_verify_wait', { projectId, pageId, graceMs: verifyGraceMs });
        verifyWaitLogged = true;
      } else if (lastMessageRole === 'assistant' && settled && (progressed || !hasFiles)) {
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
