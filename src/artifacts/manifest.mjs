import { createHash } from 'node:crypto';
import { frameRequest, ArtifactsHttpError } from './api.mjs';

/** @typedef {{path:string, size?:number, contentType?:string, sha256:string}} ManifestFile */

// T0 verified manifestPageContext=any: use the existing RPC page, never open Cowork.
export async function getManifest(scoped, id, overrides = {}) {
  const request = overrides.frameRequest || frameRequest;
  const raw = await request(scoped, 'GET', `/api/frame/${encodeURIComponent(id)}?via=user_open&bk=initial&actor=id&vt=1`);
  if (!raw || !Array.isArray(raw.files) || raw.files.some((file) => typeof file.path !== 'string' || typeof file.sha256 !== 'string')) {
    throw new TypeError(`Invalid artifact manifest: ${id}`);
  }
  return { ver: raw.ver, assetToken: raw.assetToken, title: raw.title, updatedAt: new Date(raw.updated_at).toISOString(), files: raw.files };
}

/** @param {readonly ManifestFile[]} files */
export function projectFiles(files) {
  return files.filter((file) => file.path.startsWith('project/')).map((file) => ({ ...file, rel: file.path.slice('project/'.length) }));
}

/** @param {readonly ManifestFile[]} files */
export function artifactSignature(files) {
  const lines = projectFiles(files).map((file) => `${file.rel}:${file.sha256}`).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

export async function fetchFileBytes(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
  if (response.status !== 200) {
    // Never expose the asset token embedded in the download URL in errors.
    throw new ArtifactsHttpError(response.status, new URL(url).pathname);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** @param {readonly ManifestFile[]} files @param {string} requested */
export function resolveFilePath(files, requested) {
  const entry = files.find((file) => file.path === requested) || files.find((file) => file.path === `project/${requested}`);
  if (!entry) throw new Error(`file not found: ${requested}`);
  return entry;
}
