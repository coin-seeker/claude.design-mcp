import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactsCreate } from '../src/artifacts/generate.mjs';

export function fixture(patch = {}) {
  const calls = [];
  const page = {};
  const deps = {
    ensureSession: async () => { calls.push('session'); return { page, org: 'org' }; },
    withOperationPage: async (_session, fn) => fn(page),
    withRpcPage: async (_session, fn) => fn(page),
    findByName: () => null,
    resolveDesign: async () => { throw new Error('remote project not found by name: Card'); },
    openNewDesign: async () => { calls.push('open'); return { projectId: 'id', sessionId: 'cse_test' }; },
    openDesignSession: async () => { calls.push('open-session'); },
    waitForInput: async () => {},
    frameRequest: async (_scoped, method) => { calls.push(method === 'POST' ? 'retitle' : 'delete'); },
    ccrRequest: async (_scoped, path, method = 'GET') => { calls.push(`${method} ${path}`); return {}; },
    updateEntry: (_id, entry) => { calls.push(Object.hasOwn(entry, 'pendingCreateAt') ? (entry.pendingCreateAt === null ? 'index-ready' : 'index-pending') : entry.submittedAt ? 'index-submit' : 'index'); },
    removeEntry: () => { calls.push('remove'); },
    applyModelArtifacts: async () => { calls.push('model'); return { apiId: 'claude-opus-5-5' }; },
    applyEffortArtifacts: async () => { calls.push('effort'); return 'high'; },
    applyDesignSystemArtifacts: async (_page, name) => { calls.push('DS'); return { name }; },
    getManifest: async () => { calls.push('baseline'); return { files: [] }; },
    sendPrompt: async () => { calls.push('send'); },
    confirmSubmitted: async () => { calls.push('confirm'); },
    monitorUntilSettled: () => { calls.push('monitor'); },
    now: () => 0,
    ...patch,
  };
  return { calls, deps };
}

test('Given a fresh grounded design, when creating, then composer submission follows the approved sequence', async () => {
  const { deps, calls } = fixture();
  const result = await artifactsCreate({ prompt: 'card', designSystem: 'Brand', wait: false }, deps);
  assert.deepEqual(calls, ['session', 'open', 'index-pending', 'retitle', 'index', 'model', 'effort', 'DS', 'baseline', 'send', 'index-ready', 'confirm', 'index-submit', 'monitor']);
  assert.deepEqual(Object.keys(result).sort(), ['projectId', 'name', 'url', 'sessionId', 'backend', 'submitted', 'pending', 'model', 'effort', 'designSystem'].sort());
  assert.equal(result.url, 'https://claude.ai/cowork/cse_test?artifact=id');
});
test('Given a new design, when submitting, then the index marks the rollback window before retitle and clears it after send', async () => {
  const updates = []; // Given
  const { deps, calls } = fixture({ updateEntry: (id, entry) => { updates.push({ id, entry, after: calls.at(-1) }); } });
  await artifactsCreate({ prompt: 'card', withoutDesignSystem: true, wait: false }, deps); // When
  assert.deepEqual(updates.filter(({ entry }) => Object.hasOwn(entry, 'pendingCreateAt')), [ // Then
    { id: 'id', entry: { pendingCreateAt: '1970-01-01T00:00:00.000Z' }, after: 'open' },
    { id: 'id', entry: { pendingCreateAt: null }, after: 'send' },
  ]);
});
test('Given wait:false, when creating, then the monitor receives only the projectId after submission confirmation', async () => {
  const monitored = [];
  const { deps, calls } = fixture({ monitorUntilSettled: (...args) => { monitored.push(args); assert.ok(calls.includes('confirm')); } }); // Given
  await artifactsCreate({ prompt: 'card', withoutDesignSystem: true, wait: false }, deps); // When
  assert.deepEqual(monitored, [['id']]); // Then
});
test('Given no grounding choice, when creating, then no session is touched', async () => {
  const { deps, calls } = fixture();
  await assert.rejects(artifactsCreate({ prompt: 'card' }, deps), /designSystem is required/);
  assert.deepEqual(calls, []);
});
test('Given an indexed name, when creating without fresh, then iterate receives the requested grounding', async () => {
  let received;
  const { deps } = fixture({ findByName: () => ({ projectId: 'existing' }), artifactsIterate: async (args) => { received = args; return { backend: 'artifacts' }; } });
  const result = await artifactsCreate({ name: 'Card', prompt: 'card', designSystem: 'Brand', wait: false }, deps);
  assert.equal(received.projectId, 'existing');
  assert.equal(received.designSystem, 'Brand');
  assert.equal(result.reused, true);
  assert.equal(result.name, 'Card');
});
test('Given an exact remote name, when creating, then the remote artifact is reused', async () => {
  let reusedId;
  const { deps } = fixture({ resolveDesign: async () => ({ projectId: 'remote' }), artifactsIterate: async (args) => { reusedId = args.projectId; return {}; } });
  await artifactsCreate({ name: 'Card', prompt: 'card', withoutDesignSystem: true }, deps);
  assert.equal(reusedId, 'remote');
});
test('Given a pre-send composer failure, when creating, then the blank artifact, its Cowork session and index are removed', async () => {
  const { deps, calls } = fixture({ applyEffortArtifacts: async () => { throw new Error('effort missing'); } });
  await assert.rejects(artifactsCreate({ prompt: 'card', withoutDesignSystem: true }, deps), /effort missing/);
  assert.deepEqual(calls.slice(-3), ['delete', 'DELETE /v1/code/sessions/cse_test', 'remove']);
  assert.equal(calls.includes('send'), false);
});
test('Given a confirmation failure after send, when creating, then the submitted artifact is retained', async () => {
  const { deps, calls } = fixture({ confirmSubmitted: async () => { throw new Error('unconfirmed'); } });
  await assert.rejects(artifactsCreate({ prompt: 'card', withoutDesignSystem: true }, deps), /unconfirmed/);
  assert.equal(calls.includes('delete'), false);
  assert.equal(calls.some((call) => call.startsWith('DELETE /v1/code/sessions/')), false);
});
test('Given attachments, when creating, then each file is attached after grounding and before the baseline and send', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-attach-'));
  try {
    for (const name of ['a.png', 'b.png']) fs.writeFileSync(path.join(dir, name), 'x');
    const { deps, calls } = fixture({ attachFile: async (_page, file, name) => { calls.push(`attach:${name}`); assert.equal(file, path.join(dir, name)); } }); // Given
    await artifactsCreate({ prompt: 'card', withoutDesignSystem: true, wait: false, attachments: [path.join(dir, 'a.png'), path.join(dir, 'b.png')] }, deps); // When
    assert.deepEqual(calls.slice(calls.indexOf('DS'), calls.indexOf('send') + 1), ['DS', 'attach:a.png', 'attach:b.png', 'baseline', 'send']); // Then
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('Given a missing attachment, when creating, then the call is refused before any session work', async () => {
  const { deps, calls } = fixture();
  await assert.rejects(artifactsCreate({ prompt: 'card', withoutDesignSystem: true, attachments: ['/nonexistent/shot.png'] }, deps), /attachment not found: \/nonexistent\/shot\.png/);
  assert.deepEqual(calls, []);
});
