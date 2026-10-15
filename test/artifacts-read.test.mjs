import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { updateEntry, readIndex } from '../src/artifacts/index-store.mjs';
import { artifactSignature, projectFiles, resolveFilePath, getManifest, fetchFileBytes } from '../src/artifacts/manifest.mjs';
import { listDesigns, withDesignDetails, resolveDesign, resolveSessionId, toIso } from '../src/artifacts/listing.mjs';
import { artifactsList, artifactsGet, artifactsStatus, artifactsSystemList, artifactsDelete, artifactsLogin, readAllEvents } from '../src/artifacts/read-tools.mjs';
import { parseListFlags } from '../src/cli.mjs';
import { buildTools } from '../src/tools.mjs';

const files = [
  { path: 'project/z.html', sha256: 'z', size: 2, contentType: 'text/html' },
  { path: 'artifact-type/runtime.js', sha256: 'runtime', size: 10 },
  { path: 'project/a.png', sha256: 'a', size: 3, contentType: 'image/png' },
];
const manifest = { ver: 'v1', assetToken: 'token', title: 'Title', updatedAt: '2026-10-09T14:00:00.000Z', files };
const scoped = { page: {}, org: 'test-org' };
const baseDeps = {
  ensureSession: async () => scoped,
  withRpcPage: async (_session, fn) => fn(scoped.page),
  resolveTypeSlugs: async () => ({ design: 'design', designSystem: 'ds' }),
  readIndex: () => ({ byArtifact: {} }),
};

test('Given mixed manifest files, when signing, then only sorted stripped project paths contribute', () => {
  const expected = createHash('sha256').update('a.png:a\nz.html:z').digest('hex');
  assert.equal(artifactSignature(files), expected);
  assert.equal(artifactSignature([]), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.deepEqual(projectFiles(files).map((file) => file.rel), ['z.html', 'a.png']);
});

test('Given ambiguous paths, when resolving, then exact paths take precedence over project paths', () => {
  const entries = [...files, { path: 'z.html', sha256: 'exact' }];
  assert.equal(resolveFilePath(entries, 'z.html').sha256, 'exact');
  assert.equal(resolveFilePath(files, 'z.html').path, 'project/z.html');
  assert.equal(resolveFilePath(files, 'project/a.png').path, 'project/a.png');
  assert.equal(resolveFilePath(files, 'artifact-type/runtime.js').sha256, 'runtime');
  assert.throws(() => resolveFilePath(files, 'absent'), /file not found/);
});

test('Given any Claude page, when reading a manifest, then frame fields are normalized', async () => {
  const result = await getManifest(scoped, 'id', { frameRequest: async (_scope, method, path) => {
    assert.equal(method, 'GET');
    assert.equal(path, '/api/frame/id?via=user_open&bk=initial&actor=id&vt=1');
    return { ...manifest, updated_at: '2026-10-09T14:00:00Z', updatedAt: undefined };
  } });
  assert.deepEqual(result, manifest);
});

test('Given failed byte response, when fetching, then HTTP status is propagated', async () => {
  await assert.rejects(fetchFileBytes('https://fixture/file', async () => new Response('', { status: 404 })), /404/);
  assert.deepEqual(await fetchFileBytes('https://fixture/file', async () => new Response('ok')), Buffer.from('ok'));
});

const remote = [
  { id: 'old', title: 'Cafe\u0301', type_slug: 'design', rel: 'mine', created_at: '2026-10-08T00:00:00Z', updated_at: '2026-10-09T12:00:00Z', last_edit: { cowork: ['cse_old'] } },
  { id: 'new', title: 'Café', type_slug: 'design', rel: 'mine', updated_at: '2026-10-09T14:00:00Z' },
  { id: 'ds', title: 'System', type_slug: 'ds', updated_at: '2026-10-09T14:00:00Z' },
];
const listingDeps = { ...baseDeps, frameRequest: async (_scope, _method, path) => {
  if (path.startsWith('/api/frame/artifacts?')) return { artifacts: remote };
  if (path.startsWith('/api/frame/frames?')) return { frames: [{ slug: 'old', last_viewed_at: '2026-10-09T15:00:00Z' }, { slug: 'new', last_viewed_at: '2026-10-09T13:00:00Z' }] };
  throw new Error(`unexpected ${path}`);
} };

const dsListingDeps = { ...listingDeps, frameRequest: async (scope, method, path) => {
  if (path === '/api/frame/types/ds/instances?limit=50') return { instances: [{ slug: 'system', title: 'System', last_edit: { cowork: ['cse_system'] } }] };
  return listingDeps.frameRequest(scope, method, path);
} };

for (const [label, entry, hidden] of [
  ['recent', { pendingCreateAt: '2026-10-15T00:00:00.001Z' }, true],
  ['expired', { pendingCreateAt: '2026-10-15T00:00:00.000Z' }, false],
  ['cleared', { pendingCreateAt: null }, false],
  ['invalid', { pendingCreateAt: 'invalid' }, false],
  ['other account', { pendingCreateAt: '2026-10-15T00:00:00.001Z', account: 'sub' }, false],
]) {
  test(`Given a ${label} pending create, when listing, then visibility and over-fetch respect the rollback window`, async () => {
    const paths = []; // Given
    const deps = { ...listingDeps, now: () => Date.parse('2026-10-15T00:10:00Z'), readIndex: () => ({ byArtifact: { old: entry } }),
      frameRequest: async (...args) => { paths.push(args[2]); return listingDeps.frameRequest(...args); } };
    const result = await listDesigns(scoped, { limit: 1 }, deps); // When
    assert.deepEqual(result.map(({ projectId }) => projectId), [hidden ? 'new' : 'old']); // Then
    assert.equal(new URL(paths[0], 'https://fixture').searchParams.get('limit'), hidden ? '2' : '1');
  });
}
test('Given a pending create and a design system, when listing with default limit, then over-fetch hides only the design', async () => {
  const paths = []; // Given
  const entry = { pendingCreateAt: '2026-10-15T00:00:00Z', account: 'main' };
  const result = await listDesigns(scoped, { includeDesignSystems: true }, { ...dsListingDeps,
    now: () => Date.parse('2026-10-15T00:01:00Z'), readIndex: () => ({ byArtifact: { old: entry, system: entry } }),
    frameRequest: async (...args) => { paths.push(args[2]); return dsListingDeps.frameRequest(...args); },
  }); // When
  assert.deepEqual(result.map(({ projectId }) => projectId), ['new', 'system']); // Then
  assert.equal(new URL(paths[0], 'https://fixture').searchParams.get('limit'), '102');
});

test('Given DS instances, when opting in with a design limit, then systems append using slugs and indexed sessions', async () => {
  const result = await listDesigns(scoped, { limit: 1, includeDesignSystems: true }, { ...dsListingDeps,
    readIndex: () => ({ byArtifact: { system: { sessionId: 'cse_index' } } }),
  });
  assert.equal(result.length, 2);
  assert.deepEqual(result[1], { projectId: 'system', name: 'System', type: 'PROJECT_TYPE_DESIGN_SYSTEM', backend: 'artifacts', sessionId: 'cse_index', url: 'https://claude.ai/cowork/cse_index?artifact=system' });
});

test('Given DS opt-in and detailsFor, when calling the tool, then only the DS manifest contributes a signature', async () => {
  const fetched = [];
  const result = await artifactsList({ includeDesignSystems: true, details: true, detailsFor: ['system'], limit: 1 }, {
    ...dsListingDeps, getManifest: async (_scope, id) => { fetched.push(id); return manifest; },
  });
  assert.deepEqual(fetched, ['system']);
  assert.equal(result[1].signature, artifactSignature(files));
  assert.equal('signature' in result[0], false);
});

test('Given unavailable DS endpoint, when opting in, then the primary designs survive', async () => {
  const result = await listDesigns(scoped, { includeDesignSystems: true }, listingDeps);
  assert.deepEqual(result.map((item) => item.projectId), ['old', 'new']);
});

test('Given DS instances without an index, when resolving a session, then discovery consults DS edits', async () => {
  const sessionId = await resolveSessionId(scoped, 'system', dsListingDeps);
  assert.equal(sessionId, 'cse_system');
});

test('Given no DS flag, when listing, then no instance request is made', async () => {
  const paths = [];
  await listDesigns(scoped, {}, { ...dsListingDeps, frameRequest: async (...args) => { paths.push(args[2]); return dsListingDeps.frameRequest(...args); } });
  assert.equal(paths.some((path) => path.includes('/instances')), false);
});

test('Given CLI DS flag, when parsing, then the tool opt-in is exposed in CLI and MCP schema', () => {
  const parsed = parseListFlags(['--design-systems', '--limit', '5']);
  assert.deepEqual(parsed.flags, { includeDesignSystems: true, limit: '5' });
  assert.equal(buildTools('artifacts').find((tool) => tool.name === 'design_list').inputSchema.properties.includeDesignSystems.type, 'boolean');
});

test('Given frame view times, when listing, then Design-only items have ISO max viewedAt and Cowork links', async () => {
  const result = await listDesigns(scoped, { limit: 2 }, listingDeps);
  assert.equal(result.length, 2);
  assert.equal(result[0].viewedAt, '2026-10-09T15:00:00.000Z');
  assert.equal(result[1].viewedAt, '2026-10-09T14:00:00.000Z');
  assert.equal(result[0].url, 'https://claude.ai/cowork/cse_old?artifact=old');
  assert.equal(result[1].url, 'https://claude.ai/code/artifact/new');
  assert.equal(result[0].type, 'PROJECT_TYPE_PROJECT');
  assert.equal(result[0].backend, 'artifacts');
  assert.equal(result[0].isOwned, true);
  assert.equal(toIso('invalid'), null);
  assert.equal(toIso(null), null);
});

test('Given unavailable frame views, when listing, then updatedAt remains usable', async () => {
  const result = await listDesigns(scoped, {}, { ...listingDeps, frameRequest: async (_scope, _method, path) => {
    if (path.startsWith('/api/frame/frames?')) throw new Error('unavailable');
    return { artifacts: remote };
  } });
  assert.equal(result[0].viewedAt, '2026-10-09T12:00:00.000Z');
});

test('Given detailsFor, when listing with details, then only selected items read manifests', async () => {
  const fetched = [];
  const result = await artifactsList({ details: true, detailsFor: ['new'], limit: 2 }, {
    ...listingDeps, getManifest: async (_scope, id) => { fetched.push(id); return manifest; },
  });
  assert.deepEqual(fetched, ['new']);
  assert.equal(result[1].fileCount, 2);
  assert.equal(result[1].remoteUpdatedAt, manifest.updatedAt);
  assert.equal('signature' in result[0], false);
});

test('Given manifest failures, when adding details, then per-item errors preserve the listing', async () => {
  const items = [{ projectId: 'id', name: 'Title' }];
  const result = await withDesignDetails(scoped, items, undefined, { getManifest: async () => { throw new Error('failed'); } });
  assert.deepEqual(result, [{ ...items[0], detailsError: 'failed' }]);
});

test('Given canonically equivalent names, when resolving, then newest remote title wins', async () => {
  assert.equal((await resolveDesign(scoped, { name: 'Cafe\u0301' }, listingDeps)).projectId, 'new');
  await assert.rejects(resolveDesign(scoped, { name: 'missing' }, listingDeps), /remote project not found by name: missing/);
  const fallback = await resolveDesign(scoped, { projectId: 'absent' }, { ...listingDeps, getManifest: async () => manifest });
  assert.equal(fallback.name, 'Title');
});

test('Given failed discovery and an explicit id, when resolving, then manifest title remains readable', async () => {
  const result = await resolveDesign(scoped, { projectId: 'id' }, {
    ...baseDeps, listDesigns: async () => { throw new Error('discovery failed'); }, getManifest: async () => manifest,
  });
  assert.equal(result.name, 'Title');
});

test('Given index or listing sessions, when resolving, then index takes precedence and absence gives null', async () => {
  assert.equal(await resolveSessionId(scoped, 'old', { ...listingDeps, readIndex: () => ({ byArtifact: { old: { sessionId: 'cse_index' } } }) }), 'cse_index');
  assert.equal(await resolveSessionId(scoped, 'old', listingDeps), 'cse_old');
  assert.equal(await resolveSessionId(scoped, 'new', listingDeps), null);
});

for (const [requested, content, expected] of [['z.html', '<html/>', { text: '<html/>' }], ['a.png', 'png', { binary: true, bytes: 3 }]]) {
  test(`Given ${requested}, when getting file, then text or binary result is returned without opening pages`, async () => {
    const result = await artifactsGet({ projectId: 'id', path: requested }, {
      ...baseDeps, getManifest: async () => manifest,
      fetchFileBytes: async (url) => { assert.match(url, /\/\_f\/v1\/project\//); return Buffer.from(content); },
    });
    assert.deepEqual(result, { projectId: 'id', path: requested, contentType: requested.endsWith('html') ? 'text/html' : 'image/png', version: 'v1', backend: 'artifacts', ...expected });
  });
}

test('Given descending event pages, when reading status, then messages and last role span cursor pages', async () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/artifacts/events-done.json', import.meta.url)));
  const session = JSON.parse(readFileSync(new URL('./fixtures/artifacts/session-done.json', import.meta.url)));
  const paths = [];
  const result = await artifactsStatus({ projectId: 'id' }, {
    ...baseDeps, resolveSessionId: async () => 'cse_fixture',
    ccrRequest: async (_scope, path) => {
      paths.push(path);
      if (!path.includes('/events')) return session;
      return path.includes('cursor=') ? { data: fixture.data.slice(3), next_cursor: null } : { data: fixture.data.slice(0, 3), next_cursor: '70' };
    },
  });
  const messages = fixture.data.filter(({ payload }) => ['user', 'assistant'].includes(payload.type)).length;
  assert.equal(result.messages, messages);
  assert.equal(result.lastMessageRole, 'assistant');
  assert.equal(result.chats, 1);
  assert.equal(result.sessionStatus, 'active');
  assert.equal(result.workerStatus, 'idle');
  assert.equal(paths.at(-1), '/v1/code/sessions/cse_fixture/events?limit=100&cursor=70');
});

test('Given DS instances with a default slug, when listing systems, then default and publishedAt are mapped', async () => {
  const result = await artifactsSystemList({}, { ...baseDeps, frameRequest: async (_scope, _method, path) => {
    assert.equal(path, '/api/frame/types/ds/instances?limit=50');
    return { instances: [{ slug: 's1', title: 'System', published_at: '2026-10-09T14:00:00Z' }], default: { slug: 's1' } };
  } });
  assert.deepEqual(result, [{ name: 'System', id: 's1', account: 'main', publishedAt: '2026-10-09T14:00:00.000Z', isDefault: true }]);
});

test('Given an unconfirmed delete, when calling, then session access is refused with the standalone gate', async () => {
  await assert.rejects(artifactsDelete({ projectId: 'id' }, { ensureSession: () => { throw new Error('session must not open'); } }), {
    message: 'design_delete requires confirm: true. Only call this when the user explicitly asked to delete the project.',
  });
});

test('Given a confirmed delete, when calling, then remote deletion precedes index removal', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'artifacts-read-'));
  const previous = process.env.CLAUDE_DESIGN_STATE_DIR;
  process.env.CLAUDE_DESIGN_STATE_DIR = dir;
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_DESIGN_STATE_DIR; else process.env.CLAUDE_DESIGN_STATE_DIR = previous; rmSync(dir, { recursive: true, force: true }); });
  updateEntry('id', { name: 'Title', sessionId: 'cse_fixture' });
  const calls = [];
  const result = await artifactsDelete({ projectId: 'id', confirm: true }, {
    ...baseDeps, frameRequest: async (_scope, method, path) => {
      assert.equal(readIndex().byArtifact.id.name, 'Title');
      calls.push([method, path]);
    },
  });
  assert.deepEqual(calls, [['DELETE', '/api/frame/id']]);
  assert.equal(readIndex().byArtifact.id, undefined);
  assert.deepEqual(result, { projectId: 'id', deleted: true, backend: 'artifacts' });
});

test('Given repeated event cursors, when paging, then the read fails instead of looping', async () => {
  await assert.rejects(readAllEvents(scoped, 'cse_fixture', { ccrRequest: async () => ({ data: [], next_cursor: 'same' }) }), /cursor repeated/);
});

test('Given large string sequences, when reading events, then numeric order is exact and duplicates are removed', async () => {
  const sequences = ['90071992547409930', '90071992547409929', '90071992547409930', '9'];
  const events = await readAllEvents(scoped, 'cse_fixture', { ccrRequest: async () => ({ data: sequences.map((sequence_num) => ({ sequence_num, payload: { type: 'assistant' } })), next_cursor: null }) });
  assert.deepEqual(events.map((event) => event.sequence_num), ['9', '90071992547409929', '90071992547409930']);
});

test('Given a failing remote delete, when calling, then index removal is skipped', async () => {
  let removed = false;
  await assert.rejects(artifactsDelete({ projectId: 'id', confirm: true }, {
    ...baseDeps, frameRequest: async () => { throw new Error('denied'); }, removeEntry: () => { removed = true; },
  }), /denied/);
  assert.equal(removed, false);
});

test('Given a login retry, when authentication succeeds, then force-visible login returns artifacts context', async () => {
  let attempts = 0;
  const result = await artifactsLogin({}, { ...baseDeps, withRpcPage: async (_session, fn) => fn({ evaluate: async () => null }), delay: async () => {}, ensureSession: async (options) => {
    assert.deepEqual(options, { visible: true, force: true });
    if (++attempts === 1) throw new Error('not yet');
    return scoped;
  } });
  assert.equal(attempts, 2);
  assert.deepEqual(result, { loggedIn: true, email: null, org: 'test-org', account: 'main', backend: 'artifacts' });
});
