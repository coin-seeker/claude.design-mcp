import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, chmodSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
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

// Additional accounts live in <state dir>/accounts.json and are added only by design_login.
export const ACCOUNT_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const FIRST_EXTRA_PORT = 9379;
const stateDir = () => expandHome(process.env.CLAUDE_DESIGN_STATE_DIR || '~/.cache/claude-design-mcp');
const registryPath = () => path.join(stateDir(), 'accounts.json');
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validEntry = (value) => isRecord(value) && typeof value.profile === 'string' && path.isAbsolute(value.profile)
  && Number.isInteger(value.port) && value.port > 0 && value.port < 65536;

function readRegistry() {
  try {
    const registry = JSON.parse(readFileSync(registryPath(), 'utf8'));
    if (!isRecord(registry) || registry.v !== 1 || !isRecord(registry.accounts)) return {};
    return Object.fromEntries(Object.entries(registry.accounts)
      .filter(([name, entry]) => ACCOUNT_NAME.test(name) && !Object.hasOwn(ACCOUNTS, name) && validEntry(entry)));
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && 'code' in error && error.code === 'ENOENT')) return {};
    throw error;
  }
}

function writeRegistry(accounts) {
  const file = registryPath();
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ v: 1, accounts }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function listAccounts() {
  return [...Object.keys(ACCOUNTS), ...Object.keys(readRegistry()).sort()];
}

export function accountConfig(name) {
  if (Object.hasOwn(ACCOUNTS, name)) return ACCOUNTS[name];
  const entry = readRegistry()[name];
  if (!entry) throw unknownAccount(name);
  return entry;
}

function unknownAccount(value) {
  return new TypeError(`Unknown account: ${String(value)}. Known: ${listAccounts().join(', ')}. Add one with design_login({account:"<name>"}) (lowercase letters, digits, hyphens).`);
}

export function resolveAccount(value = 'main') {
  if (typeof value === 'string' && (Object.hasOwn(ACCOUNTS, value) || Object.hasOwn(readRegistry(), value))) return value;
  throw unknownAccount(value);
}

// Idempotent: built-in and already registered names are returned unchanged.
export function registerAccount(value) {
  if (typeof value !== 'string' || !ACCOUNT_NAME.test(value)) {
    throw new TypeError(`Invalid account name: ${String(value)} (expected ${ACCOUNT_NAME.source})`);
  }
  if (Object.hasOwn(ACCOUNTS, value)) return value;
  const accounts = readRegistry();
  if (Object.hasOwn(accounts, value)) return value;
  const used = new Set([...Object.values(ACCOUNTS), ...Object.values(accounts)].map((account) => account.port));
  let port = FIRST_EXTRA_PORT;
  while (used.has(port)) port++;
  writeRegistry({ ...accounts, [value]: { profile: path.join(stateDir(), `chrome-profile-${value}`), port } });
  return value;
}

export function currentAccount() { return context.getStore() ?? 'main'; }

export function withAccount(name, fn) { return context.run(resolveAccount(name), fn); }
