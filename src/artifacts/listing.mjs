import { frameRequest } from './api.mjs';
import { resolveTypeSlugs } from './types.mjs';
import { readIndex } from './index-store.mjs';
import { getManifest, projectFiles, artifactSignature } from './manifest.mjs';
import { listLimit } from '../list-details.mjs';
import { createPool } from '../variants.mjs';
import { currentAccount } from '../accounts.mjs';

const READ_DEPS = { frameRequest, resolveTypeSlugs, readIndex, getManifest };

export function toIso(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function artifactUrl(projectId, sessionId, chatId) {
  if (chatId) return `https://claude.ai/chat/${encodeURIComponent(chatId)}?artifact=${encodeURIComponent(projectId)}`;
  return sessionId
    ? `https://claude.ai/cowork/${encodeURIComponent(sessionId)}?artifact=${encodeURIComponent(projectId)}`
    : `https://claude.ai/code/artifact/${encodeURIComponent(projectId)}`;
}

async function designSystemInstances(scoped, deps) {
  try {
    const { designSystem } = await deps.resolveTypeSlugs(scoped);
    const response = await deps.frameRequest(scoped, 'GET', `/api/frame/types/${encodeURIComponent(designSystem)}/instances?limit=50`);
    if (!Array.isArray(response?.instances) || response.instances.some((item) => typeof item.slug !== 'string' || typeof item.title !== 'string')) {
      throw new TypeError('Invalid Design System instances');
    }
    return response.instances;
  } catch (error) {
    // DS discovery is best-effort, like frame-view enrichment.
    if (!(error instanceof Error)) throw error;
    return [];
  }
}

export async function listDesigns(scoped, { limit, includeDesignSystems = false } = {}, overrides = {}) {
  const deps = { ...READ_DEPS, ...overrides };
  const slugs = await deps.resolveTypeSlugs(scoped);
  const response = await deps.frameRequest(scoped, 'GET', `/api/frame/artifacts?rel=mine&type=${encodeURIComponent(slugs.design)}&limit=${listLimit(limit) ?? 100}`);
  if (!Array.isArray(response?.artifacts)) throw new TypeError('Invalid artifacts listing');
  let frames = [];
  try {
    const views = await deps.frameRequest(scoped, 'GET', '/api/frame/frames?thumb=1&limit=60');
    frames = Array.isArray(views?.frames) ? views.frames : [];
  } catch (error) {
    // View enrichment is best-effort; the primary listing has already succeeded.
    if (!(error instanceof Error)) throw error;
  }
  const viewed = new Map(frames.map((frame) => [frame.slug, toIso(frame.last_viewed_at)]));
  const index = deps.readIndex();
  const designs = response.artifacts.filter((item) => !item.type_slug || item.type_slug === slugs.design).map((item) => {
    if (typeof item.id !== 'string' || typeof item.title !== 'string') throw new TypeError('Invalid Design listing item');
    const updatedAt = toIso(item.updated_at);
    const lastViewed = viewed.get(item.id);
    const sessionId = item.last_edit?.cowork?.[0] || index.byArtifact[item.id]?.sessionId || null;
    const entry = index.byArtifact[item.id];
    return {
      projectId: item.id, name: item.title, type: 'PROJECT_TYPE_PROJECT', isOwned: item.rel === 'mine',
      createdAt: toIso(item.created_at), updatedAt, viewedAt: [lastViewed, updatedAt].filter(Boolean).sort().at(-1) || null,
      ...(entry?.surface === 'chat' ? {} : { sessionId }), account: currentAccount(), backend: 'artifacts', url: artifactUrl(item.id, sessionId, entry?.chatId),
    };
  }).slice(0, listLimit(limit) ?? 100);
  if (!includeDesignSystems) return designs;
  const systems = await designSystemInstances(scoped, deps);
  return [...designs, ...systems.map((item) => {
    const entry = index.byArtifact[item.slug];
    const sessionId = entry?.sessionId || null;
    return { projectId: item.slug, name: item.title, type: 'PROJECT_TYPE_DESIGN_SYSTEM', backend: 'artifacts', sessionId,
      url: artifactUrl(item.slug, sessionId, entry?.chatId) };
  })];
}

// The fourth argument is the adapter DI bag; the first three preserve T3's public contract.
export async function withDesignDetails(scoped, items, only, overrides = {}) {
  const deps = { ...READ_DEPS, ...overrides };
  const wanted = Array.isArray(only) ? new Set(only.map(String)) : null;
  const acquire = createPool(4);
  return Promise.all(items.map((item) => acquire(async () => {
    if (wanted && !wanted.has(item.projectId)) return item;
    try {
      const manifest = await deps.getManifest(scoped, item.projectId, deps);
      return { ...item, fileCount: projectFiles(manifest.files).length, remoteUpdatedAt: manifest.updatedAt, signature: artifactSignature(manifest.files) };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { ...item, detailsError: error.message };
    }
  })));
}

export async function resolveDesign(scoped, { projectId, name } = {}, overrides = {}) {
  const deps = { ...READ_DEPS, listDesigns, ...overrides };
  if (!projectId && !name) throw new Error('projectId or name is required');
  let items;
  try {
    items = await deps.listDesigns(scoped, {}, deps);
  } catch (error) {
    // Direct ids remain readable even when discovery is unavailable.
    if (!(error instanceof Error) || !projectId) throw error;
    items = [];
  }
  if (projectId) {
    const found = items.find((item) => item.projectId === projectId);
    if (found) return found;
    const manifest = await deps.getManifest(scoped, projectId, deps);
    const entry = deps.readIndex().byArtifact[projectId];
    const sessionId = entry?.sessionId || null;
    return { projectId, name: manifest.title, type: 'PROJECT_TYPE_PROJECT', ...(entry?.surface === 'chat' ? {} : { sessionId }), backend: 'artifacts', url: artifactUrl(projectId, sessionId, entry?.chatId) };
  }
  const target = name.normalize('NFC');
  const found = items.filter((item) => (item.account ?? 'main') === currentAccount() && item.name.normalize('NFC') === target)
    .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))[0];
  if (!found) throw new Error(`remote project not found by name: ${name}`);
  return found;
}

export async function resolveSessionId(scoped, id, overrides = {}) {
  const deps = { ...READ_DEPS, listDesigns, ...overrides };
  const indexed = deps.readIndex().byArtifact[id]?.sessionId;
  if (indexed) return indexed;
  const items = await deps.listDesigns(scoped, {}, deps);
  const sessionId = items.find((item) => item.projectId === id)?.sessionId;
  if (sessionId) return sessionId;
  const systems = await designSystemInstances(scoped, deps);
  return systems.find((item) => item.slug === id)?.last_edit?.cowork?.[0] || null;
}
