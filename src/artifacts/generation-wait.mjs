import { setTimeout as delay } from 'node:timers/promises';
import { currentAccount, withAccount } from '../accounts.mjs';
import { beginActivity, endActivity } from '../idle-close.mjs';
import { logEvent } from '../log.mjs';
import { ccrRequest } from './api.mjs';
import { readAllEvents, isRealPrompt, EMPTY_SIGNATURE } from './turn.mjs';
import { artifactsCheck } from './check.mjs';
import { readChatMessages, chatPromptCount } from './chat-turn.mjs';

const WAIT_DEPS = { delay, now: Date.now, ccrRequest, readAllEvents, readChatMessages, artifactsCheck };
const MONITOR_DEPS = { delay, now: Date.now, artifactsCheck, beginActivity, endActivity, logEvent };
const monitors = new Map();

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

export function monitorUntilSettled(projectId, overrides = {}) {
  const deps = { ...MONITOR_DEPS, ...overrides };
  const intervalMs = overrides.intervalMs ?? Number(process.env.CLAUDE_DESIGN_MONITOR_INTERVAL_MS ?? 30_000);
  const leaseMs = overrides.leaseMs ?? Number(process.env.CLAUDE_DESIGN_PAGE_LEASE_MS ?? 2_700_000);
  const existing = monitors.get(projectId);
  if (existing) {
    existing.deadline = deps.now() + leaseMs;
    return existing.promise;
  }
  const account = currentAccount();
  const entry = { deadline: deps.now() + leaseMs, promise: null };
  // Schedule after registration so even an immediately settled check cannot leave a stale entry.
  entry.promise = Promise.resolve().then(async () => {
    try {
      deps.beginActivity(account);
      deps.logEvent('artifacts.monitor_start', { projectId, account, intervalMs });
      for (;;) {
        try {
          const result = await withAccount(account, () => deps.artifactsCheck({ projectId }));
          if (result.status !== 'generating') {
            deps.logEvent('artifacts.monitor_complete', { projectId, status: result.status });
            return;
          }
        } catch (error) {
          deps.logEvent('artifacts.monitor_poll_failed', { projectId, error: String(error?.message ?? error) });
        }
        if (deps.now() >= entry.deadline) {
          deps.logEvent('artifacts.monitor_timeout', { projectId });
          return;
        }
        await deps.delay(intervalMs);
      }
    } finally {
      monitors.delete(projectId);
      deps.endActivity(account);
    }
  // Detached monitoring must not reject, including failures in timer/activity/logging dependencies.
  }).catch(() => undefined);
  monitors.set(projectId, entry);
  return entry.promise;
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
