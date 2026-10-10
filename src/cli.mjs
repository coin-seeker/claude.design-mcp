import { resolveAccount } from './accounts.mjs';

const GENERATE_FLAGS = {
  '--no-wait': { key: 'wait', value: false },
  '--model': { key: 'model' },
  '--effort': { key: 'effort' },
  '--design-system': { key: 'designSystem' },
};

// create-only: opting out of a design system is a choice the composer picker can still honour, and the
// picker is gone by the time iterate runs, so iterate must keep rejecting the flag as unknown.
const CREATE_FLAGS = {
  ...GENERATE_FLAGS,
  '--without-design-system': { key: 'withoutDesignSystem', value: true },
};

const SYNC_FLAGS = {
  '--timeout-ms': { key: 'timeoutMs' },
  '--account': { key: 'account' },
};

const LIST_FLAGS = { '--details': { key: 'details', value: true }, '--limit': { key: 'limit' }, '--design-systems': { key: 'includeDesignSystems', value: true } };

export function parseFlags(args, definitions) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const definition = definitions[argument];
    if (!definition) {
      if (argument.startsWith('--')) throw new Error(`Unknown flag: ${argument}. Supported: ${Object.keys(definitions).join(', ')}`);
      positional.push(argument);
      continue;
    }
    if (Object.hasOwn(definition, 'value')) flags[definition.key] = definition.value;
    else {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      flags[definition.key] = value;
      index += 1;
    }
  }
  return { positional, flags };
}

export function parseCreateFlags(args) {
  return parseFlags(args, CREATE_FLAGS);
}

export function parseGenerateFlags(args) {
  return parseFlags(args, GENERATE_FLAGS);
}

export function parseSyncFlags(args) {
  const parsed = parseFlags(args, SYNC_FLAGS);
  if (parsed.flags.account !== undefined) resolveAccount(parsed.flags.account);
  return parsed;
}

export function parseListFlags(args) {
  return parseFlags(args, LIST_FLAGS);
}
