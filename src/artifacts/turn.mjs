import { createHash } from 'node:crypto';
import { ccrRequest } from './api.mjs';

export const EMPTY_SIGNATURE = createHash('sha256').update('').digest('hex');

export function isRealPrompt(event) {
  const payload = event.payload;
  return payload.type === 'user' && typeof payload.message?.content === 'string' && payload.isSynthetic !== true;
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

function isHandshakeResult({ num_turns, total_cost_usd }) {
  return num_turns === 0 && !total_cost_usd;
}

// This domain snapshot preserves the approved classifier's public input contract.
export function classifyArtifactTurn({ session, events, signature, submitSignature, now = Date.now(), stallMs = Number(process.env.CLAUDE_DESIGN_STALL_MS || 600_000) }) {
  const ordered = newestFirst(events);
  const base = { lastMessageRole: lastMessageRole(ordered) };
  if (session.requires_action_details_list?.length) {
    return { ...base, status: 'awaiting_input', requiresAction: session.requires_action_details_list.map(({ type }) => ({ type })) };
  }

  const prompt = ordered.find(isRealPrompt);
  const idle = session.worker_status === 'idle' && session.status_bucket === 'completed';
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
      ...(typeof total_cost_usd === 'number' ? { costUsd: total_cost_usd } : {}),
    };
    if (is_error || subtype !== 'success') return { ...base, ...usage, status: 'interrupted', problem: `result_${subtype || 'error'}` };
    const changed = signature !== EMPTY_SIGNATURE && (submitSignature == null || signature !== submitSignature);
    return { ...base, ...usage, status: changed ? 'done' : 'no_output' };
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
