import { mkdirSync, chmodSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { expandHome } from '../helpers.mjs';
import { currentAccount } from '../accounts.mjs';

const indexPath = () => path.join(expandHome(process.env.CLAUDE_DESIGN_STATE_DIR || '~/.cache/claude-design-mcp'), 'artifacts-index.json');
const emptyIndex = () => ({ v: 1, byArtifact: {} });
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function validEntry(value) {
  if (!isRecord(value)) return false;
  for (const field of ['name', 'sessionId', 'workspaceSessionId', 'chatId', 'surface', 'lastSubmitSignature', 'submittedAt', 'account']) {
    if (value[field] !== undefined && value[field] !== null && typeof value[field] !== 'string') return false;
  }
  return value.promptCountAtSubmit === undefined || (Number.isInteger(value.promptCountAtSubmit) && value.promptCountAtSubmit >= 0);
}

export function readIndex() {
  try {
    const index = JSON.parse(readFileSync(indexPath(), 'utf8'));
    if (!isRecord(index) || index.v !== 1 || !isRecord(index.byArtifact) || !Object.values(index.byArtifact).every(validEntry)) return emptyIndex();
    return index;
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && 'code' in error && error.code === 'ENOENT')) return emptyIndex();
    throw error;
  }
}

function writeIndex(index) {
  const file = indexPath();
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function updateEntry(id, patch) {
  const index = readIndex();
  const entry = { ...(Object.hasOwn(index.byArtifact, id) ? index.byArtifact[id] : {}), ...patch, account: patch.account ?? currentAccount() };
  if (!validEntry(entry)) throw new TypeError(`Invalid artifacts index entry: ${id}`);
  writeIndex({ v: 1, byArtifact: { ...index.byArtifact, [id]: entry } });
  return entry;
}

export function removeEntry(id) {
  const index = readIndex();
  const byArtifact = { ...index.byArtifact };
  delete byArtifact[id];
  writeIndex({ v: 1, byArtifact });
}

export function findByName(name) {
  const matches = Object.entries(readIndex().byArtifact)
    .filter(([, entry]) => (entry.account ?? 'main') === currentAccount() && typeof entry.name === 'string' && entry.name.normalize('NFC') === name.normalize('NFC'))
    .sort(([, a], [, b]) => (Date.parse(b.submittedAt) || 0) - (Date.parse(a.submittedAt) || 0));
  const match = matches[0];
  return match ? { ...match[1], projectId: match[0] } : null;
}
