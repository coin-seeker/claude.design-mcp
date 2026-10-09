import { resolveAccount } from './accounts.mjs';
import { readIndex } from './artifacts/index-store.mjs';

export function resolveAccountFor(tool, args = {}, overrides = {}) {
  if (args.account !== undefined) return resolveAccount(args.account);
  if (args.projectId) {
    const entry = (overrides.readIndex ?? readIndex)().byArtifact[args.projectId];
    if (entry?.account !== undefined) return resolveAccount(entry.account);
  }
  return resolveAccount();
}
