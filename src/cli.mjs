const GENERATE_FLAGS = {
  '--no-wait': { key: 'wait', value: false },
  '--model': { key: 'model' },
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
};

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
  return parseFlags(args, SYNC_FLAGS);
}
