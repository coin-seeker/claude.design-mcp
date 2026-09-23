import { createHash } from 'node:crypto';

export const EMPTY_SIGNATURE = createHash('sha256').update('').digest('hex');

export function fileSignature(entries) {
  const pairs = entries.filter((entry) => entry.type === 'file').map((entry) => `${entry.path}:${entry.version}`).sort();
  return createHash('sha256').update(pairs.join('\n')).digest('hex');
}

export function remoteUpdatedAtOf(entries) {
  return entries.reduce((latest, entry) => entry.updatedAt && (!latest || entry.updatedAt > latest) ? entry.updatedAt : latest, null);
}
