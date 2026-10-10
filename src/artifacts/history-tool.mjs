import { ensureSession, withRpcPage } from '../session.mjs';
import { readIndex } from './index-store.mjs';
import { resolveSessionId, toIso } from './listing.mjs';
import { readAllEvents } from './read-tools.mjs';
import { readChatMessages } from './chat-turn.mjs';
import { isRealPrompt } from './turn.mjs';

const READ_DEPS = { ensureSession, withRpcPage, readIndex, resolveSessionId, readAllEvents, readChatMessages };

function origin(text) {
  if (text.startsWith('Sync the attached materialized design-system package.') || text.startsWith('Correct the previous sync.')) return 'mcp-sync';
  if (text.startsWith('Apply exactly these literal replacements to the project file ')) return 'mcp-edit';
  return 'unknown';
}

function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n');
}

function promptTurn(text, ts, index) {
  return { index, ts, text: text.slice(0, 8000), origin: origin(text), reply: null, result: null };
}

function coworkTurns(events) {
  const ordered = [...events].sort((a, b) => {
    const left = BigInt(a.sequence_num), right = BigInt(b.sequence_num);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  // Accumulators retain the most recent session total and the baseline before each real prompt.
  const turns = [];
  let total = 0;
  let baseline = 0;
  for (const event of ordered) {
    const { payload } = event;
    if (isRealPrompt(event)) {
      baseline = total;
      const received = payload.server_received_wall_ms;
      const ts = received == null ? null : toIso(Number(received));
      turns.push(promptTurn(payload.message.content, ts ?? event.created_at ?? null, turns.length));
      continue;
    }
    const turn = turns.at(-1);
    switch (payload.type) {
      case 'assistant': {
        const text = textContent(payload.message?.content);
        if (turn && text) turn.reply = text.slice(0, 500);
        break;
      }
      case 'result':
        if (turn && payload.num_turns !== 0) {
          turn.result = {
            status: payload.is_error ? 'error' : payload.subtype ?? 'success',
            costUsd: typeof payload.total_cost_usd === 'number' ? Math.max(0, payload.total_cost_usd - baseline) : null,
            numTurns: typeof payload.num_turns === 'number' ? payload.num_turns : null,
          };
        }
        if (typeof payload.total_cost_usd === 'number') total = payload.total_cost_usd;
        break;
      default: break; // Control, synthetic user, and system events do not alter the turn.
    }
  }
  return turns;
}

function chatTurns(messages) {
  const turns = [];
  for (const message of [...messages].sort((a, b) => a.index - b.index)) {
    const text = textContent(message.content);
    switch (message.sender) {
      case 'human': turns.push(promptTurn(text, message.created_at ?? null, turns.length)); break;
      case 'assistant':
        if (turns.length && text) turns.at(-1).reply = text.slice(0, 500);
        break;
      default: break; // System/tool senders are not prompts; skip them rather than failing the whole history.
    }
  }
  return turns;
}

export async function artifactsHistory(args = {}, overrides = {}) {
  const projectId = String(args.projectId ?? '').trim();
  if (!projectId) throw new Error('projectId is required');
  const deps = { ...READ_DEPS, ...overrides };
  const session = await deps.ensureSession({ visible: false });
  return deps.withRpcPage(session, async (page) => {
    const scoped = { ...session, page };
    const entry = deps.readIndex().byArtifact[projectId];
    if (entry?.surface === 'chat' && entry.chatId) {
      const messages = await deps.readChatMessages(scoped, entry.chatId, deps);
      return { projectId, backend: 'artifacts', surface: 'chat', sessionId: entry.sessionId ?? null, chatId: entry.chatId, turns: chatTurns(messages) };
    }
    const sessionId = await deps.resolveSessionId(scoped, projectId, deps);
    if (!sessionId) throw new Error(`no Cowork session found for artifact ${projectId}`);
    const events = await deps.readAllEvents(scoped, sessionId, deps);
    return { projectId, backend: 'artifacts', surface: 'cowork', sessionId, chatId: null, turns: coworkTurns(events) };
  });
}
