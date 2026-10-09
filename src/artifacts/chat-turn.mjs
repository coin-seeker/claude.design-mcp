import { designApiRequest } from './api.mjs';
import { EMPTY_SIGNATURE, FINISHED_BUCKETS } from './turn.mjs';

export async function findWorkspaceSessionId(scoped, chatId, deps = {}) {
  const request = deps.designApiRequest ?? designApiRequest;
  for (let offset = 0; offset < 200; offset += 50) {
    const path = `/api/organizations/${encodeURIComponent(scoped.org)}/chat_conversations_v2?limit=50&offset=${offset}&archived=false&consistency=strong`;
    const items = await request(scoped, 'GET', path);
    if (!Array.isArray(items)) throw new TypeError('Invalid chat conversations page');
    const chat = items.find((item) => item.uuid === chatId);
    if (chat) return typeof chat.workspace_session_id === 'string' ? chat.workspace_session_id : null;
    if (items.length < 50) break;
  }
  return null;
}

export async function readChatMessages(scoped, chatId, overrides = {}) {
  const request = overrides.designApiRequest ?? designApiRequest;
  const path = `/api/organizations/${encodeURIComponent(scoped.org)}/chat_conversations/${encodeURIComponent(chatId)}?tree=True&rendering_mode=messages&render_all_tools=true`;
  const response = await request(scoped, 'GET', path);
  if (!Array.isArray(response?.chat_messages) || response.chat_messages.some((message) =>
    !Number.isInteger(message?.index) || !['human', 'assistant'].includes(message.sender) || !Array.isArray(message.content))) {
    throw new TypeError('Invalid chat conversation messages');
  }
  return response.chat_messages;
}

// Prep assistant/tool_use messages before the first human are not part of a design turn.
export function chatConversation(messages) {
  const ordered = [...messages].sort((a, b) => b.index - a.index);
  const firstHuman = ordered.filter((message) => message.sender === 'human').at(-1);
  return firstHuman ? ordered.filter((message) => message.index >= firstHuman.index) : [];
}

export function chatLastMessageRole(messages) {
  const newest = chatConversation(messages)[0];
  if (!newest) return null;
  switch (newest.sender) {
    case 'human': return 'user';
    case 'assistant': return 'assistant';
    default: throw new TypeError(`Unexpected chat sender: ${newest.sender}`);
  }
}

export const chatPromptCount = (messages) => messages.filter((message) => message.sender === 'human').length;
const TERMINAL_STOPS = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal']);

export function chatIdle(messages, session) {
  if (session) return session.worker_status === 'idle' && FINISHED_BUCKETS.has(session.status_bucket);
  const ordered = chatConversation(messages);
  const human = ordered.find((message) => message.sender === 'human');
  if (!human) return true;
  const assistant = ordered.find((message) => message.sender === 'assistant' && message.index > human.index);
  return Boolean(assistant && TERMINAL_STOPS.has(assistant.stop_reason));
}

// The chat API does not expose an in-progress assistant message (it appears only once the turn ends, measured
// 2026-10-10: a 10m14s design-system turn showed nothing after the prompt until end_turn), and
// completion_status.is_pending stays false while a turn streams. So a chat turn counts as stalled only after a much
// longer silence than Cowork; override with CLAUDE_DESIGN_CHAT_STALL_MS.
const CHAT_STALL_MS = () => Number(process.env.CLAUDE_DESIGN_CHAT_STALL_MS || 1_800_000);

export function classifyChatTurn({ messages, signature, submitSignature, session, now = Date.now(), stallMs = CHAT_STALL_MS(), sessionStallMs = Number(process.env.CLAUDE_DESIGN_STALL_MS || 600_000) }) {
  const ordered = chatConversation(messages);
  const base = { lastMessageRole: chatLastMessageRole(messages) };
  if (session && !chatIdle(messages, session)) {
    if (session.requires_action_details_list?.length) {
      return { ...base, status: 'awaiting_input', requiresAction: session.requires_action_details_list.map(({ type }) => ({ type })) };
    }
    const stalled = now - Date.parse(session.last_event_at) > sessionStallMs;
    return { ...base, status: stalled ? 'stalled' : 'generating' };
  }
  const human = ordered.find((message) => message.sender === 'human');
  if (!human) return { ...base, status: 'stalled' };
  const assistant = ordered.find((message) => message.sender === 'assistant' && message.index > human.index);
  switch (assistant?.stop_reason) {
    case 'end_turn':
    case 'stop_sequence': {
      const changed = signature !== EMPTY_SIGNATURE && (submitSignature == null || signature !== submitSignature);
      return { ...base, status: changed ? 'done' : 'no_output' };
    }
    case 'max_tokens':
    case 'refusal': return { ...base, status: 'interrupted', problem: `result_${assistant.stop_reason}` };
    default: {
      if (session) {
        // A new prompt may arrive before the previous turn's idle snapshot changes; REST replies also lag.
        const reference = Math.max(Date.parse(session.last_event_at) || 0, Date.parse(human.created_at) || 0);
        return now - reference < 60_000 ? { ...base, status: 'generating' }
          : { ...base, status: 'interrupted', problem: 'idle_without_result' };
      }
      const stalled = now - Date.parse(ordered[0].updated_at) > stallMs;
      return { ...base, status: stalled ? 'stalled' : 'generating' };
    }
  }
}
