import { logEvent } from './log.mjs';

// Per-account idle scheduler for the session Chrome. Only the MCP server enables it (startIdleClose);
// the CLI never does, so begin/end there are plain counters.
export const DEFAULT_IDLE_CLOSE_MS = 20 * 60_000;

const counts = new Map();
const timers = new Map();
const closing = new Map();
let config = null;

export function idleCloseMs(env = process.env) {
  const raw = String(env.CLAUDE_DESIGN_IDLE_CLOSE_MS ?? '').trim();
  if (!/^\d+$/.test(raw)) return DEFAULT_IDLE_CLOSE_MS;
  return Number(raw);
}

function clearTimer(account) {
  const timer = timers.get(account);
  if (timer === undefined) return;
  config.clearTimer(timer);
  timers.delete(account);
}

function fire(account) {
  timers.delete(account);
  if ((counts.get(account) ?? 0) > 0 || closing.has(account)) return;
  const { close } = config;
  let outcome = {};
  const pending = Promise.resolve()
    .then(() => close(account))
    .then(
      (result) => { outcome = result ?? {}; },
      (error) => { logEvent('chrome.idle_close_failed', { account, error: String(error?.message ?? error) }); },
    )
    .finally(() => {
      closing.delete(account);
      // Foreign tabs (CLI or other work) defer the close; retry after another idle period.
      if (outcome.deferred) arm(account);
    });
  closing.set(account, pending);
}

function arm(account) {
  if (!config || (counts.get(account) ?? 0) > 0 || closing.has(account)) return;
  clearTimer(account);
  const timer = config.setTimer(() => fire(account), config.ms);
  timer?.unref?.();
  timers.set(account, timer);
}

export function startIdleClose({ close, accounts = ['main', 'sub'], ms, setTimer = setTimeout, clearTimer: clear = clearTimeout }) {
  config = { close, ms, setTimer, clearTimer: clear };
  for (const account of accounts) arm(account);
}

export function beginActivity(account) {
  counts.set(account, (counts.get(account) ?? 0) + 1);
  if (config) clearTimer(account);
}

export function endActivity(account) {
  const next = Math.max(0, (counts.get(account) ?? 0) - 1);
  counts.set(account, next);
  if (next === 0) arm(account);
}

// ensureSession waits here so a relaunch never hands off to a Chrome that is still exiting.
export function whenIdleCloseSettled(account) {
  return closing.get(account) ?? Promise.resolve();
}

export function stopIdleClose() {
  if (config) for (const account of [...timers.keys()]) clearTimer(account);
  counts.clear();
  timers.clear();
  closing.clear();
  config = null;
}
