import { createHash } from 'node:crypto';

export function classifyTurnRequest(url) {
  const text = String(url ?? '');
  let path = text.split(/[?#]/, 1)[0];
  try { path = new URL(text).pathname; } catch (error) { void error; }
  if (path.endsWith('/Chat')) return 'chat';
  if (path.endsWith('/RenewTurn')) return 'renew';
  if (path.endsWith('/ReleaseTurn')) return 'release';
  // Not part of a turn, but it races one: the composer's design-system picker persists every click
  // through this RPC, and the prompt must not be submitted before those responses land.
  if (path.endsWith('/UpdateProjectDesignSystems')) return 'design-system';
  return 'other';
}

export function stabilitySignature(entries) {
  const rows = (Array.isArray(entries) ? entries : [])
    .map((entry) => `${String(entry?.path ?? '')}:${Number(entry?.size ?? 0)}`)
    .sort();
  return createHash('sha256').update(rows.join('\n')).digest('hex');
}

export function signatureStable(history, n = 2) {
  const needed = Math.max(1, Number(n) || 1);
  if (!Array.isArray(history) || history.length < needed) return false;
  const tail = history.slice(-needed);
  return tail.every((signature) => signature && signature === tail[0]);
}
