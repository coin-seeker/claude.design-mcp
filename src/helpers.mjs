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

export function lastMessageRoleOf(raw) {
  const role = lastMessageOf(decodeProjectData(raw))?.role;
  return role === 'assistant' || role === 'user' ? role : null;
}

export function expandHome(value) {
  const text = String(value);
  return text === '~' || text.startsWith('~/') ? path.join(homedir(), text.slice(2)) : text;
}
