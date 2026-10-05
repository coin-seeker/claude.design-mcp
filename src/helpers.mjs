import { homedir } from 'node:os';
import path from 'node:path';

export function sanitizeName(name) {
  return String(name ?? '').normalize('NFC').replace(/[\\/\0]/g, '').trim() || 'design';
}

export function sanitizeRelPath(rel, root) {
  const raw = String(rel ?? '');
  if (path.isAbsolute(raw)) throw new Error(`absolute path rejected: ${raw}`);
  const parts = raw.split(/[\\/]+/).filter((part) => part && part !== '.');
  if (!parts.length || parts.some((part) => part === '..' || path.isAbsolute(part))) throw new Error(`unsafe path rejected: ${raw}`);
  const safe = parts.join(path.sep);
  const base = path.resolve(root);
  const resolved = path.resolve(base, safe);
  if (!resolved.startsWith(base + path.sep)) throw new Error(`path escapes output directory: ${raw}`);
  return safe;
}

export function decodeToBuffer(b64) {
  return Buffer.from(String(b64), 'base64');
}

// ListFiles responds with { entries, total, limit }; tolerate a `files` alias.
export function fileEntriesOf(page) {
  return (page && (page.entries || page.files)) || [];
}

export function generatedFileEntries(entries) {
  return (Array.isArray(entries) ? entries : []).filter((entry) => !/^_ds(?:\/|$)/.test(String(entry?.path || '')));
}

export function decodeProjectData(raw) {
  return raw?.data ? JSON.parse(decodeToBuffer(raw.data).toString('utf8')) : raw;
}

export function lastMessageOf(data) {
  const chats = Object.values(data?.chats || {});
  const messages = chats.flatMap((chat) => Array.isArray(chat.messages) ? chat.messages : []);
  return messages.at(-1) ?? null;
}

const WRITE_TOOLS = new Set(['write_file', 'str_replace_edit', 'create_file', 'delete_file', 'move_file', 'copy_file', 'edit_file']);
const VERIFY_TOOLS = new Set(['ready_for_verification']);

function toolNames(message) {
  return (message?.contentBlocks || []).filter((block) => block?.type === 'tool_call').map((block) => block.toolCall?.name);
}

function hasTurnChanges(message) {
  const changes = message?.turnChanges;
  return Boolean(changes) && Object.values(changes).some((value) => Array.isArray(value) && value.length > 0);
}

// The latest turn = every message after the last real prompt (async results arrive as pill user messages
// and belong to the same turn). A turn that ends inside a thinking block without having written anything
// was cut off by claude.ai — it is not a finished design even when older turns left files behind.
export function turnStateOf(data) {
  const messages = Object.values(data?.chats || {}).flatMap((chat) => Array.isArray(chat.messages) ? chat.messages : []);
  const last = messages.at(-1) ?? null;
  const role = last?.role === 'assistant' || last?.role === 'user' ? last.role : null;
  let promptIndex = -1;
  messages.forEach((message, index) => { if (message?.role === 'user' && message.pill !== true) promptIndex = index; });
  const replies = messages.slice(promptIndex + 1).filter((message) => message?.role === 'assistant');
  const produced = replies.some((message) => hasTurnChanges(message) || toolNames(message).some((name) => WRITE_TOOLS.has(name)));
  const lastBlock = role === 'assistant' ? (last.contentBlocks || []).at(-1) : null;
  const lastAt = Date.parse(last?.timestamp ?? '');
  return {
    role,
    produced,
    cutOff: role === 'assistant' && !produced && lastBlock?.type === 'thinking',
    verificationPending: role === 'assistant' && toolNames(last).some((name) => VERIFY_TOOLS.has(name)),
    lastAt: Number.isFinite(lastAt) ? lastAt : null,
  };
}

export function lastMessageRoleOf(raw) {
  const role = lastMessageOf(decodeProjectData(raw))?.role;
  return role === 'assistant' || role === 'user' ? role : null;
}

export function expandHome(value) {
  const text = String(value);
  return text === '~' || text.startsWith('~/') ? path.join(homedir(), text.slice(2)) : text;
}
