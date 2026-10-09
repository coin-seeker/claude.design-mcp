import { setTimeout as delay } from 'node:timers/promises';
import { ensureSession, withRpcPage, loginHelp } from '../session.mjs';
import { isTextProjectFile } from '../project-file.mjs';
import { frameRequest, ccrRequest, frameFileUrl } from './api.mjs';
import { resolveTypeSlugs } from './types.mjs';
import { removeEntry, readIndex } from './index-store.mjs';
import { getManifest, resolveFilePath, fetchFileBytes } from './manifest.mjs';
import { listDesigns, withDesignDetails, resolveSessionId, toIso } from './listing.mjs';

const READ_DEPS = {
  ensureSession, withRpcPage, frameRequest, ccrRequest, resolveTypeSlugs, readIndex, removeEntry,
  getManifest, fetchFileBytes, listDesigns, withDesignDetails, resolveSessionId, readAllEvents, delay, now: Date.now,
};

function requireString(value, name) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

async function onRpc(deps, fn) {
  const session = await deps.ensureSession({ visible: false });
  return deps.withRpcPage(session, (page) => fn({ ...session, page }));
}

// Self-contained for T3; T8 can inject T4's readAllEvents through the same DI key.
export async function readAllEvents(scoped, sessionId, overrides = {}) {
  const request = overrides.ccrRequest || ccrRequest;
  const events = new Map();
  const cursors = new Set();
  let cursor = null;
  do {
    const query = `limit=100${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
    const page = await request(scoped, `/v1/code/sessions/${encodeURIComponent(sessionId)}/events?${query}`);
    if (!Array.isArray(page?.data)) throw new TypeError('Invalid Cowork events page');
    for (const event of page.data) {
      if (typeof event.sequence_num !== 'string' || !/^\d+$/.test(event.sequence_num) || !event.payload) throw new TypeError('Invalid Cowork event');
      if (events.size < 2_000) events.set(event.sequence_num, event);
    }
    cursor = page.next_cursor ?? null;
    if (cursor !== null && cursors.has(cursor)) throw new Error('Cowork events cursor repeated');
    cursors.add(cursor);
  } while (cursor !== null && events.size < 2_000);
  return [...events.values()].sort((a, b) => {
    const left = BigInt(a.sequence_num), right = BigInt(b.sequence_num);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

export async function artifactsList(args = {}, overrides = {}) {
  const deps = { ...READ_DEPS, ...overrides };
  return onRpc(deps, async (scoped) => {
    const items = await deps.listDesigns(scoped, { limit: args.limit }, deps);
    return args.details === true ? deps.withDesignDetails(scoped, items, args.detailsFor, deps) : items;
  });
}

export async function artifactsGet(args = {}, overrides = {}) {
  const deps = { ...READ_DEPS, ...overrides };
  const projectId = requireString(args.projectId, 'projectId');
  const path = requireString(args.path, 'path');
  return onRpc(deps, async (scoped) => {
    const manifest = await deps.getManifest(scoped, projectId, deps);
    const file = resolveFilePath(manifest.files, path);
    const bytes = await deps.fetchFileBytes(frameFileUrl(projectId, manifest.ver, file.path, manifest.assetToken), deps.fetchImpl);
    const contentType = file.contentType || 'application/octet-stream';
    const result = { projectId, path, contentType, version: manifest.ver, backend: 'artifacts' };
    return isTextProjectFile(contentType, file.path)
      ? { ...result, text: bytes.toString('utf8') }
      : { ...result, binary: true, bytes: bytes.length };
  });
}

export async function artifactsStatus(args = {}, overrides = {}) {
  const deps = { ...READ_DEPS, ...overrides };
  const projectId = requireString(args.projectId, 'projectId');
  return onRpc(deps, async (scoped) => {
    const sessionId = await deps.resolveSessionId(scoped, projectId, deps);
    if (!sessionId) throw new Error(`no Cowork session found for artifact ${projectId}`);
    const [session, events] = await Promise.all([
      deps.ccrRequest(scoped, `/v1/code/sessions/${encodeURIComponent(sessionId)}`), deps.readAllEvents(scoped, sessionId, deps),
    ]);
    let messages = 0;
    let lastMessageRole = null;
    // Events include non-chat control/system payloads and result markers, not just messages.
    for (const { payload } of events) {
      switch (payload.type) {
        case 'user': messages++; lastMessageRole = 'user'; break;
        case 'assistant': messages++; lastMessageRole = 'assistant'; break;
        case 'result': lastMessageRole = 'assistant'; break;
        default: break;
      }
    }
    return { projectId, chats: 1, messages, lastMessageRole, sessionId, backend: 'artifacts', sessionStatus: session.status, workerStatus: session.worker_status };
  });
}

export async function artifactsSystemList(_args = {}, overrides = {}) {
  const deps = { ...READ_DEPS, ...overrides };
  return onRpc(deps, async (scoped) => {
    const { designSystem } = await deps.resolveTypeSlugs(scoped);
    const response = await deps.frameRequest(scoped, 'GET', `/api/frame/types/${encodeURIComponent(designSystem)}/instances?limit=50`);
    if (!Array.isArray(response?.instances)) throw new TypeError('Invalid Design System instances');
    return response.instances.map((item) => {
      if (typeof item.title !== 'string' || typeof item.slug !== 'string') throw new TypeError('Invalid Design System instance');
      const publishedAt = toIso(item.published_at);
      return { name: item.title, id: item.slug, ...(publishedAt ? { publishedAt } : {}), isDefault: item.slug === response.default?.slug };
    });
  });
}

export async function artifactsDelete(args = {}, overrides = {}) {
  if (args.confirm !== true) throw new Error('design_delete requires confirm: true. Only call this when the user explicitly asked to delete the project.');
  const projectId = requireString(args.projectId, 'projectId');
  const deps = { ...READ_DEPS, ...overrides };
  return onRpc(deps, async (scoped) => {
    await deps.frameRequest(scoped, 'DELETE', `/api/frame/${encodeURIComponent(projectId)}`);
    deps.removeEntry(projectId);
    return { projectId, deleted: true, backend: 'artifacts' };
  });
}

export async function artifactsLogin(_args = {}, overrides = {}) {
  const deps = { ...READ_DEPS, ...overrides };
  const deadline = deps.now() + 180_000;
  let last = null;
  while (deps.now() < deadline) {
    try {
      const session = await deps.ensureSession({ visible: true, force: true });
      return { loggedIn: true, email: null, org: session.org, backend: 'artifacts' };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      last = error;
      await deps.delay(2_000);
    }
  }
  throw last || new Error(loginHelp('login did not complete before timeout'));
}
