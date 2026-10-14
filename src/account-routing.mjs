import { registerAccount, resolveAccount } from './accounts.mjs';
import { readIndex } from './artifacts/index-store.mjs';

export function resolveAccountFor(tool, args = {}, overrides = {}) {
  // design_login is the only way to add an account; other tools reject unregistered names.
  if (args.account !== undefined) return tool === 'design_login' ? registerAccount(args.account) : resolveAccount(args.account);
  if (args.projectId) {
    const entry = (overrides.readIndex ?? readIndex)().byArtifact[args.projectId];
    if (entry?.account !== undefined) return resolveAccount(entry.account);
  }
  return resolveAccount();
}
