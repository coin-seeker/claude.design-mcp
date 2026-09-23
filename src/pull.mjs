import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { decodeProjectData, decodeToBuffer, expandHome, fileEntriesOf, sanitizeName, sanitizeRelPath } from './helpers.mjs';
import { downloadZipExpression, omelette } from './rpc.mjs';
import { fileSignature, remoteUpdatedAtOf } from './signature.mjs';

export const DEFAULT_OUT = process.env.CLAUDE_DESIGN_DIR || process.cwd();
const PULL_CONCURRENCY = 4;
const THUMBNAIL_NAME = '.thumbnail';

// Private twin of tools.mjs createPool: tools.mjs already imports this module, so importing back would cycle.
function createParallelPool(limit) {
  let active = 0;
  const queue = [];
  const release = () => {
    active -= 1;
    const run = queue.shift();
    if (run) run();
  };
  return (job) => new Promise((resolve, reject) => {
    const run = () => {
      active += 1;
      Promise.resolve().then(job).then(resolve, reject).finally(release);
    };
    if (active < limit) run();
    else queue.push(run);
  });
}

export function projectView(project) {
  return {
    projectId: project.projectId,
    name: project.name,
    type: project.type,
    isOwned: project.isOwned,
    createdAt: project.createdAt ?? project.created_at,
    updatedAt: project.updatedAt ?? project.updated_at,
    viewedAt: project.viewedAt,
  };
}

function recencyKey(project) {
  const value = project?.updatedAt ?? project?.viewedAt ?? project?.createdAt ?? 0;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

async function callOmelette(session, method, body = {}) {
  return omelette(session.page, method, body, session.org);
}

// ListProjects answers 20 items per page (favourites first, then most recently viewed);
// `limit` stops paging as soon as that many items are in hand.
export async function readAllProjectItems(session, call = omelette, { limit } = {}) {
  const items = [];
  let cursor;
  for (let visited = 0; visited < 50; visited += 1) {
    const page = await call(session.page, 'ListProjects', cursor ? { cursor } : {}, session.org);
    const current = Array.isArray(page?.items) ? page.items : [];
    items.push(...current);
    cursor = page?.cursor;
    if (!cursor || !current.length || (limit && items.length >= limit)) break;
  }
  return limit ? items.slice(0, limit) : items;
}

export async function listProjects(session, { refresh = false } = {}, call = omelette) {
  if (session.projects && !refresh) return session.projects;
  session.projects = (await readAllProjectItems(session, call)).map(projectView);
  return session.projects;
}

export async function resolveProject(session, { projectId, name }, call = omelette) {
  const projects = await listProjects(session, {}, call);
  if (!projectId) return selectProject(projects, { name });
  const listed = projects.find((project) => project.projectId === projectId);
  if (listed) return listed;
  const data = decodeProjectData(await call(session.page, 'GetProjectData', { projectId }, session.org));
  return { projectId, name: data?.name || projectId, type: 'PROJECT_TYPE_PROJECT' };
}

export function selectProject(projects, { projectId, name }) {
  if (projectId) return projects.find((project) => project.projectId === projectId) || { projectId, name: projectId };
  if (!name) throw new Error('design_pull requires projectId or name');
  const lower = String(name).toLowerCase();
  const exact = projects.filter((item) => item.name === name);
  const matches = exact.length ? exact : projects.filter((item) => String(item.name).toLowerCase() === lower);
  if (!matches.length) throw new Error(`remote project not found by name: ${name}`);
  // Deterministic on name collisions: newest (by updated/created) wins instead of an arbitrary first match.
  return matches.length === 1 ? matches[0] : [...matches].sort((a, b) => recencyKey(b) - recencyKey(a))[0];
}

export async function listAllFiles(session, projectId) {
  const all = [];
  for (let guard = 0; guard < 50; guard += 1) {
    const page = await callOmelette(session, 'ListFiles', { projectId, depth: 100, offset: all.length });
    const entries = fileEntriesOf(page);
    all.push(...entries);
    const total = Number(page.total ?? all.length);
    if (!entries.length || all.length >= total) break;
  }
  return all;
}

export async function downloadZip(session, projectId) {
  const zip = await session.page.evaluate(downloadZipExpression(projectId));
  if (!zip?.ok || !zip.content) throw new Error(`download zip failed with HTTP ${zip?.status ?? 'unknown'}`);
  return decodeToBuffer(zip.content);
}

async function writeRemoteFile(session, projectId, entry, root) {
  const rel = sanitizeRelPath(entry.path, root).normalize('NFC');
  try {
    const file = await callOmelette(session, 'GetFile', { projectId, path: entry.path });
    const bytes = decodeToBuffer(file.content || '');
    const target = path.join(root, rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
    return { path: rel, bytes: bytes.length };
  } catch (error) {
    return { path: rel, error: String(error?.message || error) };
  }
}

export async function pullProject(session, projectOrId, outDir = DEFAULT_OUT, { zip = false } = {}) {
  const project = typeof projectOrId === 'object' ? projectOrId : await resolveProject(session, { projectId: projectOrId });
  const baseDir = path.resolve(expandHome(outDir || DEFAULT_OUT));
  const safeName = sanitizeName(project.name);
  if (zip) {
    const bytes = await downloadZip(session, project.projectId);
    await mkdir(baseDir, { recursive: true });
    const file = path.join(baseDir, `${safeName}.zip`);
    await writeFile(file, bytes);
    return { project, dir: baseDir, files: [{ path: file, bytes: bytes.length }], signature: null };
  }
  const root = path.join(baseDir, safeName).normalize('NFC');
  await mkdir(root, { recursive: true });
  const entries = await listAllFiles(session, project.projectId);
  const targets = entries.filter((entry) => entry.type !== 'directory' && entry.path);
  const acquire = createParallelPool(PULL_CONCURRENCY);
  // Promise.all keeps the ListFiles order; a single failed GetFile is reported instead of aborting the pull.
  const results = await Promise.all(targets.map((entry) => acquire(() => writeRemoteFile(session, project.projectId, entry, root))));
  const files = results.filter((result) => result.error === undefined);
  const errors = results.filter((result) => result.error !== undefined);
  const thumb = files.find((file) => path.basename(file.path) === THUMBNAIL_NAME);
  return {
    project,
    dir: root,
    files,
    signature: fileSignature(entries),
    remoteUpdatedAt: remoteUpdatedAtOf(entries),
    ...(errors.length ? { errors } : {}),
    ...(thumb ? { thumbnail: path.join(root, thumb.path).normalize('NFC') } : {}),
  };
}

export async function deleteProject(session, projectId) {
  return callOmelette(session, 'DeleteProject', { projectId });
}
