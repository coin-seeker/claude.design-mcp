import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildTools } from '../src/tools.mjs';
const TOOLS = buildTools('standalone');

test('Given focus-free tools, when advertising them, then metadata names the no-visible-navigation contract', () => {
  const names = ['design_list', 'design_pull', 'design_get', 'design_status', 'design_edit', 'design_delete', 'design_preview', 'design_system_list'];
  assert.equal(TOOLS.filter((tool) => names.includes(tool.name)).length, names.length);
  for (const tool of TOOLS.filter((item) => names.includes(item.name))) assert.match(tool.description, /never opens, focuses, or navigates/);
  assert.match(TOOLS.find((tool) => tool.name === 'design_check').description, /RPC-first/);
});

test('Given published package metadata, when reading version, then it is 0.16.1', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, '0.16.1');
});
