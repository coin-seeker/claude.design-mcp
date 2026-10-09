import { createHash } from 'node:crypto';
import { ccrRequest } from './api.mjs';

export const EMPTY_SIGNATURE = createHash('sha256').update('').digest('hex');

// Composer model/effort switches echo as string user events (`<local-command-stdout>Set model to …`,
// measured 2026-10-10); they are not prompts and must not start or confirm a turn.
const LOCAL_COMMAND = /^\s*<(local-command-[a-z]+|command-[a-z]+)>/;

export function isRealPrompt(event) {
  const payload = event.payload;
  return payload.type === 'user' && typeof payload.message?.content === 'string' && payload.isSynthetic !== true
    && !LOCAL_COMMAND.test(payload.message.content);
}

function newestFirst(events) {
  return [...events].sort((left, right) => {
    const a = BigInt(left.sequence_num);
    const b = BigInt(right.sequence_num);
    return a > b ? -1 : a < b ? 1 : 0;
  });
}

export function lastMessageRole(events) {
  const last = newestFirst(events).find(({ payload }) => ['user', 'assistant', 'result'].includes(payload.type));
  if (!last) return null;
  switch (last.payload.type) {
    case 'user': return 'user';
    case 'assistant':
    case 'result': return 'assistant';
    default: throw new TypeError(`Unexpected conversation event: ${last.payload.type}`);
  }
}

const PICKUP_GRACE_MS = 30_000;
export const FINISHED_BUCKETS = new Set(['completed', 'blocked', 'review_ready']);

// total_cost_usd is cumulative per session, so a handshake after the first turn carries a non-zero cost;
// zero turns alone identifies it.
function isHandshakeResult({ num_turns }) {
  return num_turns === 0;
}

// Per-turn cost: the session total at this result minus the last total reported before the prompt.
function turnCost(ordered, prompt, total) {
  if (typeof total !== 'number') return null;
  const before = ordered.find((event) => event.payload.type === 'result'
    && typeof event.payload.total_cost_usd === 'number'
    && BigInt(event.sequence_num) < BigInt(prompt.sequence_num));
  return Math.max(0, total - (before ? before.payload.total_cost_usd : 0));
}

// This domain snapshot preserves the approved classifier's public input contract.
export function classifyArtifactTurn({ session, events, signature, submitSignature, now = Date.now(), stallMs = Number(process.env.CLAUDE_DESIGN_STALL_MS || 600_000) }) {
  const ordered = newestFirst(events);
  const base = { lastMessageRole: lastMessageRole(ordered) };
  if (session.requires_action_details_list?.length) {
    return { ...base, status: 'awaiting_input', requiresAction: session.requires_action_details_list.map(({ type }) => ({ type })) };
  }

  const prompt = ordered.find(isRealPrompt);
  // `blocked` = the turn ended but Claude left a follow-up question (post_turn_summary.status_category
  // "need_input", measured 2026-10-10); the worker is just as finished as with `completed`.
  const idle = session.worker_status === 'idle' && FINISHED_BUCKETS.has(session.status_bucket);
  const summary = session.post_turn_summary ?? session.external_metadata?.post_turn_summary;
  const question = session.status_bucket === 'blocked'
    ? { problem: `need_input: ${String(summary?.needs_action || summary?.status_detail || 'Claude asked a follow-up question').slice(0, 300)}` }
    : {};
  // A running worker owns the turn: session init handshakes emit zero-turn `result` events right after
  // the prompt (measured 2026-10-09), so results are only trusted once the worker is idle again.
  if (!idle) {
    const stalled = now - Date.parse(session.last_event_at) > stallMs;
    return { ...base, status: stalled ? 'stalled' : 'generating' };
  }
  const result = prompt && ordered.find((event) => event.payload.type === 'result'
    && BigInt(event.sequence_num) > BigInt(prompt.sequence_num)
    && !isHandshakeResult(event.payload));
  if (result) {
    const { subtype, is_error, num_turns, total_cost_usd } = result.payload;
    const usage = {
      ...(typeof num_turns === 'number' ? { numTurns: num_turns } : {}),
      ...(typeof total_cost_usd === 'number' ? { costUsd: turnCost(ordered, prompt, total_cost_usd) } : {}),
    };
    if (is_error || subtype !== 'success') return { ...base, ...usage, status: 'interrupted', problem: `result_${subtype || 'error'}` };
    const changed = signature !== EMPTY_SIGNATURE && (submitSignature == null || signature !== submitSignature);
    if (!changed && question.problem) return { ...base, ...usage, ...question, status: 'awaiting_input' };
    return { ...base, ...usage, ...question, status: changed ? 'done' : 'no_output' };
  }
  // The worker can still read idle for a moment after the prompt lands, before it picks the turn up.
  const receivedAt = Number(prompt?.payload.server_received_wall_ms);
  if (Number.isFinite(receivedAt) && now - receivedAt < PICKUP_GRACE_MS) return { ...base, status: 'generating' };
  if (prompt) return { ...base, status: 'interrupted', problem: 'idle_without_result' };
  return { ...base, status: 'stalled' };
}

export async function readAllEvents(scoped, sessionId, overrides = {}) {
  const request = overrides.ccrRequest ?? ccrRequest;
  const events = [];
  const cursors = new Set();
  let cursor = null;
  do {
    const path = `/v1/code/sessions/${encodeURIComponent(sessionId)}/events?limit=100${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
    const page = await request(scoped, path);
    if (!Array.isArray(page?.data)) throw new TypeError('Invalid Cowork events page: expected data array');
    events.push(...page.data.slice(0, 2000 - events.length));
    cursor = page.next_cursor ?? null;
    if (events.length === 2000 || cursor === null) break;
    if (cursors.has(cursor)) throw new Error(`Repeated Cowork events cursor: ${cursor}`);
    cursors.add(cursor);
  } while (cursor !== null);
  return events;
}
