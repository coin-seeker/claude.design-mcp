import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactsCreate, artifactsIterate } from '../src/artifacts/generate.mjs';
import { artifactsSystemSync } from '../src/artifacts/ds-sync.mjs';
import { artifactsCheck } from '../src/artifacts/check.mjs';
import { artifactsStatus } from '../src/artifacts/read-tools.mjs';
import { listDesigns, resolveDesign } from '../src/artifacts/listing.mjs';
import { artifactsEdit } from '../src/artifacts/edit.mjs';
import { fixture as createFixture } from './artifacts-create.test.mjs';
import { fixture as syncFixture } from './artifacts-ds-sync.test.mjs';

const ID = '6837677f-340d-46ef-adb0-365073b3e0ff';
const CHAT = '22222222-2222-2222-2222-222222222222';
const identity = { surface: 'chat', chatId: CHAT, sessionId: null, projectId: ID };
const url = `https://claude.ai/chat/${CHAT}?artifact=${ID}`;
const human = { index: 1, sender: 'human', stop_reason: null, content: [], updated_at: '2026-10-10T00:00:00Z' };
const done = { ...human, index: 2, sender: 'assistant', stop_reason: 'end_turn' };

function readDeps(messages) {
  return {
    ensureSession: async () => ({ org: 'org', page: {} }), withRpcPage: async (session, fn) => fn(session.page),
    readIndex: () => ({ byArtifact: { [ID]: { ...identity, lastSubmitSignature: 'old' } } }),
    readChatMessages: async (_scope, id) => { assert.equal(id, CHAT); return messages; },
    ccrRequest: async () => assert.fail('Cowork called'), resolveSessionId: async () => assert.fail('Cowork resolution called'),
  };
}

test('Given Chat create, when submitting, then index stores surface and strict result omits session and chat metadata', async () => {
  const entries = [];
  const f = createFixture({ openNewDesign: async () => identity, updateEntry: (_id, entry) => entries.push(entry),
    confirmSubmitted: async (_scope, target, before) => { assert.deepEqual(target, identity); assert.equal(before, 0); } }); // Given
  const result = await artifactsCreate({ prompt: 'card', withoutDesignSystem: true, wait: false }, f.deps); // When
  assert.equal(result.url, url); // Then
  assert.equal(result.sessionId, undefined);
  assert.deepEqual(Object.keys(result).sort(), ['backend', 'effort', 'model', 'name', 'pending', 'projectId', 'submitted', 'url', 'withoutDesignSystem'].sort());
  assert.equal(entries.find((entry) => entry.surface)?.surface, 'chat');
  assert.equal(entries.find((entry) => entry.surface)?.chatId, CHAT);
});

for (const [label, messages, allowed] of [['running', [human], false], ['tool_use', [human, { ...done, stop_reason: 'tool_use' }], false],
  ['end_turn', [human, done], true], ['max_tokens', [human, { ...done, stop_reason: 'max_tokens' }], true], ['no human', [], true]]) {
  test(`Given Chat ${label}, when iterating, then idle gate and human count control submission`, async () => {
    let pages = 0, recorded;
    const deps = { ...readDeps(messages), withOperationPage: async (_session, fn) => { pages++; return fn({}); },
      openDesignSession: async (_page, target, id) => { assert.deepEqual(target, identity); assert.equal(id, ID); },
      applyModelArtifacts: async () => ({ apiId: 'claude-opus-5-5' }), applyEffortArtifacts: async () => 'extra',
      getManifest: async () => ({ files: [] }), sendPrompt: async () => {}, monitorUntilSettled: () => {},
      readAllEvents: async () => assert.fail('Cowork events called'), updateEntry: (_id, entry) => { recorded = entry; },
      confirmSubmitted: async (_scope, target, before) => { assert.deepEqual(target, identity); assert.equal(before, messages.length ? 1 : 0); },
    }; // Given
    const action = () => artifactsIterate({ projectId: ID, prompt: 'change', wait: false }, deps); // When
    if (!allowed) {
      await assert.rejects(action(), /turn is still running/); // Then
      assert.equal(pages, 0);
    } else {
      const result = await action();
      assert.equal(result.url, url);
      assert.equal(Object.hasOwn(result, 'sessionId'), false);
      assert.equal(Object.hasOwn(result, 'chatId'), false);
      assert.equal(recorded.surface, 'chat');
      assert.equal(recorded.chatId, CHAT);
      assert.equal(recorded.promptCountAtSubmit, messages.length ? 2 : 1);
    }
  });
}

test('Given Chat check, when a human is awaiting a reply, then user role and strict keys are preserved', async () => {
  const deps = { ...readDeps([human]), now: () => Date.parse(human.updated_at), signature: async () => 'new',
    readManifest: async () => ({ updatedAt: human.updated_at, files: [{ path: 'project/card.html', size: 1, sha256: 'sha' }] }) }; // Given
  const result = await artifactsCheck({ projectId: ID }, deps); // When
  assert.equal(result.lastMessageRole, 'user'); // Then
  assert.equal(result.status, 'generating');
  assert.deepEqual(Object.keys(result).sort(), ['answeredQuestions', 'backend', 'checkPath', 'files', 'lastMessageRole', 'projectId', 'remoteUpdatedAt', 'signature', 'status'].sort());
});

for (const messages of [[human], [human, done]]) test(`Given Chat status ending with ${messages.at(-1).sender}, when reading status, then dashboard role and null worker state are returned`, async () => {
  const result = await artifactsStatus({ projectId: ID }, readDeps(messages)); // When
  assert.deepEqual(result, { projectId: ID, chats: 1, messages: messages.length, lastMessageRole: messages.length === 1 ? 'user' : 'assistant',
    account: 'main', backend: 'artifacts', sessionStatus: null, workerStatus: null }); // Then
});

test('Given prep before a human, when reading status, then prep is not counted as conversation', async () => {
  const result = await artifactsStatus({ projectId: ID }, readDeps([{ ...done, index: 0, stop_reason: 'tool_use' }, human])); // When
  assert.equal(result.messages, 1); // Then
  assert.equal(result.lastMessageRole, 'user');
});

test('Given indexed Chat artifact, when listing or resolving a direct fallback, then URLs are Chat and sessionId is omitted', async () => {
  const deps = { ...readDeps([]), resolveTypeSlugs: async () => ({ design: 'design' }),
    frameRequest: async (_scope, _method, path) => path.startsWith('/api/frame/artifacts?') ? { artifacts: [{ id: ID, title: 'Card' }] } : { frames: [] },
    getManifest: async () => ({ title: 'Card' }) }; // Given
  const result = await listDesigns({}, {}, deps); // When
  assert.equal(result[0].url, url); // Then
  assert.equal(Object.hasOwn(result[0], 'sessionId'), false);
  const fallback = await resolveDesign({}, { projectId: ID }, { ...deps, listDesigns: async () => [] });
  assert.equal(fallback.url, url);
  assert.equal(Object.hasOwn(fallback, 'sessionId'), false);
});

test('Given Chat DS creation, when syncing, then confirmation and index use Chat without reported cost', async () => {
  const entries = [];
  const f = syncFixture();
  Object.assign(f.deps, { openNewDesignSystem: async () => identity, readAllEvents: async () => assert.fail('Cowork events called'),
    readChatMessages: async () => [], updateEntry: (_id, entry) => entries.push(entry),
    confirmSubmitted: async (_scope, target, before) => { assert.deepEqual(target, identity); assert.equal(before, 0); } }); // Given
  const result = await artifactsSystemSync({ dir: '/package' }, f.deps); // When
  assert.equal(result.ok, true); // Then
  assert.equal(result.url, url);
  assert.equal(Object.hasOwn(result, 'sessionId'), false);
  assert.equal(Object.hasOwn(result, 'costUsd'), false);
  assert.equal(entries[0].surface, 'chat');
});

for (const [label, location] of [['cowork', `https://claude.ai/cowork/cse_test?artifact=${ID}`], ['chat', url],
  ['unknown session', `https://claude.ai/chat/?artifact=${ID}`]]) {
  test(`Given ${label} artifact and failed URL poll, when DS creation fails before send, then parsed artifact and index are removed`, async () => {
    const f = syncFixture();
    Object.assign(f.deps, { withOperationPage: async (_session, fn) => fn({ url: () => location }),
      openNewDesignSystem: async () => { throw new Error('URL unavailable'); } }); // Given
    const result = await artifactsSystemSync({ dir: '/package' }, f.deps); // When
    assert.equal(result.ok, false); // Then
    assert.ok(f.calls.some((call) => call[0] === 'DELETE' && call[1] === `/api/frame/${ID}`));
    assert.ok(f.calls.some((call) => call[0] === 'remove' && call[1] === ID));
    assert.equal(f.prompts.length, 0);
    assert.equal(f.cleaned(), 1);
  });
  test(`Given ${label} artifact and failed URL poll, when design creation fails, then cleanup also uses the parsed id`, async () => {
    const f = createFixture({ withOperationPage: async (_session, fn) => fn({ url: () => location }),
      openNewDesign: async () => { throw new Error('URL unavailable'); } }); // Given
    await assert.rejects(artifactsCreate({ prompt: 'card', withoutDesignSystem: true }, f.deps), /URL unavailable/); // When
    // Then: a Cowork URL also yields the session to delete; Chat and unparseable URLs only clean the artifact.
    assert.deepEqual(f.calls.slice(label === 'cowork' ? -3 : -2), label === 'cowork'
      ? ['delete', 'DELETE /v1/code/sessions/cse_test', 'remove'] : ['delete', 'remove']);
  });
}

test('Given new Chat DS and attachment failure, when syncing, then the opened id is deleted before index cleanup', async () => {
  const f = syncFixture();
  Object.assign(f.deps, { openNewDesignSystem: async () => identity, attachFile: async () => { throw new Error('attachment failed'); } }); // Given
  const result = await artifactsSystemSync({ dir: '/package' }, f.deps); // When
  assert.equal(result.ok, false); // Then
  assert.deepEqual(f.calls.slice(-2).map((call) => call.slice(0, 2)), [['DELETE', `/api/frame/${ID}`], ['remove', ID]]);
});

test('Given a prompt already sent, when DS confirmation fails, then the artifact is retained', async () => {
  const f = syncFixture(); f.deps.confirmSubmitted = async () => { throw new Error('unconfirmed'); }; // Given
  const result = await artifactsSystemSync({ dir: '/package' }, f.deps); // When
  assert.equal(result.ok, false); // Then
  assert.equal(f.calls.some((call) => call[0] === 'DELETE' || call[0] === 'remove'), false);
});

test('Given existing target, when DS attachment fails, then it is never deleted', async () => {
  const f = syncFixture({ systems: [{ id: ID, name: 'frontend Design System' }] });
  f.deps.attachFile = async () => { throw new Error('upload failed'); }; // Given
  const result = await artifactsSystemSync({ dir: '/package' }, f.deps); // When
  assert.equal(result.ok, false); // Then
  assert.equal(f.calls.some((call) => call[0] === 'DELETE' || call[0] === 'remove'), false);
});

test('Given verified indexed Chat DS, when syncing, then skipped result also omits Cowork session and uses Chat URL', async () => {
  const f = syncFixture({ systems: [{ id: ID, name: 'frontend Design System' }], synced: true });
  f.deps.readIndex = () => ({ byArtifact: { [ID]: identity } }); // Given
  const result = await artifactsSystemSync({ dir: '/package' }, f.deps); // When
  assert.equal(result.skipped, true); // Then
  assert.equal(result.url, url);
  assert.equal(Object.hasOwn(result, 'sessionId'), false);
});

test('Given Chat literal edit, when verifying, then edit result omits sessionId', async () => {
  let reads = 0;
  const deps = { artifactsGet: async () => ({ text: reads++ ? 'b' : 'a', version: 1 }), artifactsIterate: async () => ({ url }) }; // Given
  const result = await artifactsEdit({ projectId: ID, path: 'card.html', edits: [{ oldString: 'a', newString: 'b' }] }, deps); // When
  assert.equal(result.verified, true); // Then
  assert.equal(Object.hasOwn(result, 'sessionId'), false);
});

test('Given confirmed Chat create, when discovering its workspace, then the id is stored after confirmation', async () => {
  let confirmed = false;
  const entries = [];
  const f = createFixture({ openNewDesign: async () => identity, updateEntry: (_id, entry) => entries.push(entry),
    confirmSubmitted: async () => { confirmed = true; },
    designApiRequest: async () => { assert.equal(confirmed, true); return [{ uuid: CHAT, workspace_session_id: 'cse_created' }]; } }); // Given
  const result = await artifactsCreate({ prompt: 'card', withoutDesignSystem: true, wait: false }, f.deps); // When
  assert.equal(result.pending, true); // Then
  assert.equal(entries.at(-1).workspaceSessionId, 'cse_created');
});

test('Given Chat sync, when workspace is discovered after confirmation, then the id is stored without changing strict result', async () => {
  const entries = [];
  let confirmed = false;
  const f = syncFixture();
  Object.assign(f.deps, { openNewDesignSystem: async () => identity, readChatMessages: async () => [],
    updateEntry: (_id, entry) => entries.push(entry), confirmSubmitted: async () => { confirmed = true; },
    designApiRequest: async () => { assert.equal(confirmed, true); return [{ uuid: CHAT, workspace_session_id: 'cse_sync' }]; } }); // Given
  const result = await artifactsSystemSync({ dir: '/package' }, f.deps); // When
  assert.equal(result.ok, true); // Then
  assert.equal(entries[0].workspaceSessionId, 'cse_sync');
  assert.equal(Object.hasOwn(result, 'workspaceSessionId'), false);
});

for (const [label, state, allowed] of [
  ['running with old reply', { worker_status: 'running', status_bucket: 'working' }, false],
  ['idle review_ready', { worker_status: 'idle', status_bucket: 'review_ready' }, true],
]) test(`Given cached Chat workspace ${label}, when iterating, then CCR controls the gate and retains workspace id`, async () => {
  let recorded;
  const deps = { ...readDeps([human, done]),
    readIndex: () => ({ byArtifact: { [ID]: { ...identity, workspaceSessionId: 'cse_cached' } } }),
    ccrRequest: async (_scope, path) => { assert.equal(path, '/v1/code/sessions/cse_cached'); return state; },
    withOperationPage: async (_session, fn) => fn({}), openDesignSession: async () => {},
    applyModelArtifacts: async () => ({ apiId: 'claude-opus-5-5' }), applyEffortArtifacts: async () => 'extra',
    getManifest: async () => ({ files: [] }), sendPrompt: async () => {}, monitorUntilSettled: () => {},
    updateEntry: (_id, entry) => { recorded = entry; }, confirmSubmitted: async () => {},
    designApiRequest: async () => assert.fail('cached id should skip discovery'),
  }; // Given
  const action = () => artifactsIterate({ projectId: ID, prompt: 'change', wait: false }, deps); // When
  if (!allowed) await assert.rejects(action(), /turn is still running/); // Then
  else {
    const result = await action();
    assert.equal(result.pending, true);
    assert.equal(recorded.workspaceSessionId, 'cse_cached');
  }
});

test('Given uncached Chat iterate, when confirming a new prompt, then workspace discovery is persisted', async () => {
  let recorded, confirmed = false;
  const deps = { ...readDeps([human, done]), withOperationPage: async (_session, fn) => fn({}),
    openDesignSession: async () => {}, applyModelArtifacts: async () => ({ apiId: 'claude-opus-5-5' }),
    applyEffortArtifacts: async () => 'extra', getManifest: async () => ({ files: [] }),
    sendPrompt: async () => {}, monitorUntilSettled: () => {}, updateEntry: (_id, entry) => { recorded = entry; },
    confirmSubmitted: async () => { confirmed = true; },
    designApiRequest: async () => { assert.equal(confirmed, true); return [{ uuid: CHAT, workspace_session_id: 'cse_iterated' }]; },
  }; // Given
  const result = await artifactsIterate({ projectId: ID, prompt: 'change', wait: false }, deps); // When
  assert.equal(result.pending, true); // Then
  assert.equal(recorded.workspaceSessionId, 'cse_iterated');
});
