import { AsyncLocalStorage } from 'node:async_hooks';
import { expandHome } from './helpers.mjs';

const context = new AsyncLocalStorage();

// Getters preserve the existing runtime environment overrides, including after import.
export const ACCOUNTS = {
  main: {
    get profile() { return expandHome(process.env.CLAUDE_DESIGN_PROFILE || '~/.cache/claude-design-mcp/chrome-profile'); },
    get port() { return Number(process.env.CLAUDE_DESIGN_CDP_PORT || 9377); },
  },
  sub: {
    get profile() { return expandHome(process.env.CLAUDE_DESIGN_SUB_PROFILE || '~/.cache/claude-design-mcp/chrome-profile-sub'); },
    get port() { return Number(process.env.CLAUDE_DESIGN_SUB_CDP_PORT || 9378); },
  },
};

export function resolveAccount(value = 'main') {
  if (value !== 'main' && value !== 'sub') throw new TypeError(`Unknown account: ${String(value)}`);
  return value;
}

export function currentAccount() { return context.getStore() ?? 'main'; }

export function withAccount(name, fn) { return context.run(resolveAccount(name), fn); }
