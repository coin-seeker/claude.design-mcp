import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { decodeToBuffer, expandHome, fileEntriesOf, sanitizeName, sanitizeRelPath } from './helpers.mjs';
import { downloadZipExpression, omelette } from './rpc.mjs';

export const DEFAULT_OUT = process.env.CLAUDE_DESIGN_DIR || process.cwd();

function projectView(project) {
  return { projectId: project.projectId, name: project.name, type: project.type, isOwned: project.isOwned };
}

async function callOmelette(session, method, body = {}) {
  return omelette(session.page, method, body, session.org);
}

export async function listProjects(session, { refresh = false } = {}) {
  if (session.projects && !refresh) return session.projects;
  const data = await callOmelette(session, 'ListProjects', {});
  session.projects = (Array.isArray(data.items) ? data.items : []).map(projectView);
  return session.projects;
}

export function selectProject(projects, { projectId, name }) {
  if (projectId) return projects.find((project) => project.projectId === projectId) || { projectId, name: projectId };
  if (!name) throw new Error('design_pull requires projectId or name');
  const lower = String(name).toLowerCase();
  const project = projects.find((item) => item.name === name) || projects.find((item) => String(item.name).toLowerCase() === lower);
  if (!project) throw new Error(`remote project not found by name: ${name}`);
  return project;
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

export async function pullProject(session, projectId, outDir = DEFAULT_OUT, { zip = false } = {}) {
  const project = selectProject(await listProjects(session), { projectId });
  const baseDir = path.resolve(expandHome(outDir || DEFAULT_OUT));
  const safeName = sanitizeName(project.name);
  if (zip) {
    const bytes = await downloadZip(session, project.projectId);
    await mkdir(baseDir, { recursive: true });
    const file = path.join(baseDir, `${safeName}.zip`);
    await writeFile(file, bytes);
    return { project, dir: baseDir, files: [{ path: file, bytes: bytes.length }] };
  }
  const root = path.join(baseDir, safeName);
  await mkdir(root, { recursive: true });
  const entries = await listAllFiles(session, project.projectId);
  const files = [];
  for (const entry of entries) {
    if (entry.type === 'directory' || !entry.path) continue;
    const file = await callOmelette(session, 'GetFile', { projectId: project.projectId, path: entry.path });
    const bytes = decodeToBuffer(file.content || '');
    const rel = sanitizeRelPath(entry.path, root);
    const target = path.join(root, rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
    files.push({ path: rel, bytes: bytes.length });
  }
  return { project, dir: root, files };
}

export async function deleteProject(session, projectId) {
  return callOmelette(session, 'DeleteProject', { projectId });
}
