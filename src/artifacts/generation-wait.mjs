import { setTimeout as delay } from 'node:timers/promises';
import { holdOperationPage } from '../operation-pages.mjs';
import { ccrRequest } from './api.mjs';
import { readAllEvents, isRealPrompt, EMPTY_SIGNATURE } from './turn.mjs';
import { artifactsCheck } from './check.mjs';
import { readChatMessages, chatPromptCount } from './chat-turn.mjs';

const WAIT_DEPS = { delay, now: Date.now, ccrRequest, readAllEvents, readChatMessages, artifactsCheck, holdOperationPage };

// Fourth argument is the shared DI/options seam, preserving T6's positional public contract.
export async function confirmSubmitted(scoped, sessionId, promptCountBefore, overrides = {}) {
  const deps = { ...WAIT_DEPS, ...overrides };
  const deadline = deps.now() + (overrides.timeoutMs ?? 30_000);
  do {
    if (sessionId?.surface === 'chat') {
      if (chatPromptCount(await deps.readChatMessages(scoped, sessionId.chatId, deps)) > promptCountBefore) return;
      await deps.delay(1_000);
      continue;
    }
    const [session, events] = await Promise.all([
      deps.ccrRequest(scoped, `/v1/code/sessions/${encodeURIComponent(sessionId)}`),
      deps.readAllEvents(scoped, sessionId, deps),
    ]);
    if (events.filter(isRealPrompt).length > promptCountBefore || session.worker_status !== 'idle') return;
    await deps.delay(1_000);
  } while (deps.now() < deadline);
  throw new Error('artifacts submit was not confirmed within 30s');
}

// Keeps API checks on this operation page, not an unrelated or visible tab.
function checkOnPage(scoped, projectId, deps) {
  return deps.artifactsCheck({ projectId }, {
    ...deps,
    ensureSession: async () => scoped,
    withRpcPage: async (_session, fn) => fn(scoped.page),
    ...(deps.getManifest ? { readManifest: deps.getManifest } : {}),
  });
}

export function holdUntilSettled(page, scoped, projectId, overrides = {}) {
  const deps = { ...WAIT_DEPS, ...overrides };
  const completion = (async () => {
    for (;;) {
      const result = await checkOnPage({ ...scoped, page }, projectId, deps);
      if (result.status !== 'generating') return { status: result.status, files: result.files, lastMessageRole: 'assistant', terminal: true };
      await deps.delay(10_000);
    }
  })();
  deps.holdOperationPage(page, completion, 'artifacts-turn-finished', { projectId });
}

export async function waitForArtifactTurn(scoped, turn, overrides = {}) {
  const deps = { ...WAIT_DEPS, ...overrides };
  const started = deps.now();
  const deadline = started + turn.timeoutMs;
  let result;
  do {
    result = await checkOnPage(scoped, turn.projectId, deps);
    if (result.status !== 'generating') break;
    if (deps.now() >= deadline) break;
    await deps.delay(Math.min(5_000, Math.max(0, deadline - deps.now())));
  } while (deps.now() <= deadline);
  const timedOut = result.status === 'generating';
  return {
    status: result.status, released: !timedOut, stable: !timedOut,
    ...(typeof result.costUsd === 'number' ? { costUsd: result.costUsd } : {}),
    hasFiles: result.files.length > 0,
    changed: result.signature !== EMPTY_SIGNATURE && result.signature !== turn.baseline,
    answered: false, ms: deps.now() - started, ...(timedOut ? { timedOut: true } : {}), files: result.files,
  };
}
