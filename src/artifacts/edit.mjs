import { artifactsGet } from './read-tools.mjs';
import { artifactsIterate } from './generate.mjs';

const occurrences = (text, literal) => literal ? text.split(literal).length - 1 : text.length + 1;

export async function artifactsEdit(args = {}, overrides = {}) {
  const deps = { artifactsGet, artifactsIterate, ...overrides };
  if (!Array.isArray(args.edits) || !args.edits.length) throw new Error('edits must be a non-empty array');
  const edits = args.edits.map((edit, index) => {
    if (typeof edit?.oldString !== 'string' || !edit.oldString || typeof edit.newString !== 'string') {
      throw new TypeError(`edit ${index}: oldString must be non-empty and newString must be a string`);
    }
    return { oldString: edit.oldString, newString: edit.newString };
  });
  const before = await deps.artifactsGet({ projectId: args.projectId, path: args.path }, deps);
  if (typeof before.text !== 'string') throw new Error('design_edit requires a text file');
  const blocks = edits.map(({ oldString, newString }, index) => {
    const count = occurrences(before.text, oldString);
    if (count !== 1) throw new Error(`edit ${index}: oldString must occur exactly once (found ${count})`);
    return `${index + 1}. REPLACE:\n<<<\n${oldString}\n>>>\nWITH:\n<<<\n${newString}\n>>>`;
  });
  const prompt = `Apply exactly these literal replacements to the project file ${args.path} and change nothing else. Do not create or delete files.\n${blocks.join('\n\n')}`;
  const turn = await deps.artifactsIterate({ projectId: args.projectId, prompt, effort: 'low', wait: true, timeoutMs: 240_000 }, deps);
  const after = await deps.artifactsGet({ projectId: args.projectId, path: args.path }, deps);
  if (typeof after.text !== 'string') throw new Error('design_edit verification failed: file is no longer text');
  const failures = edits.flatMap(({ oldString, newString }, index) => {
    const oldCount = occurrences(after.text, oldString);
    const newCount = occurrences(after.text, newString);
    return oldCount === 0 && newCount > 0 ? [] : [`edit ${index}: oldString count ${oldCount}, newString count ${newCount}`];
  });
  if (failures.length) throw new Error(`design_edit verification failed: ${failures.join('; ')}`);
  return { projectId: args.projectId, path: args.path, sessionId: turn.sessionId, backend: 'artifacts', applied: edits.length, verified: true, version: after.version };
}
