import path from 'node:path';
import { sanitizeRelPath } from '../helpers.mjs';
import { assetContentType } from '../preview-assets.mjs';
import { createPool } from '../variants.mjs';
import { frameFileUrl, frameOrigin } from './api.mjs';
import { fetchFileBytes, projectFiles, resolveFilePath } from './manifest.mjs';

const TEXT_FILE = /\.(?:html?|css|js|mjs|jsx|json|svg)$/i;
const BLOB_REFERENCE = /\/_blob\/([A-Za-z0-9_-]+)/g;

// Pull and preview share the exact same project/runtime/blob download layout.
export async function loadArtifactAssets(projectId, manifest, overrides = {}) {
  const fetchBytes = overrides.fetchFileBytes || fetchFileBytes;
  const acquire = createPool(4);
  const assets = new Map();
  const errors = [];
  const download = async (rel, url, contentType) => {
    try {
      const bytes = await fetchBytes(url, overrides.fetchImpl);
      return { path: rel, bytes, contentType: assetContentType(contentType, rel) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Fetch implementations may put their entire URL in an error message.
      const safeMessage = message.replaceAll(url, new URL(url).pathname);
      errors.push({ path: rel, error: safeMessage });
      return null;
    }
  };
  const files = projectFiles(manifest.files).map((file) => ({
    ...file, rel: sanitizeRelPath(file.rel, '/artifact').normalize('NFC').split(path.sep).join('/'),
  }));
  const downloaded = await Promise.all(files.map((file) => acquire(() => download(
    file.rel, frameFileUrl(projectId, manifest.ver, file.path, manifest.assetToken), file.contentType,
  ))));
  for (const asset of downloaded) if (asset) assets.set(asset.path, asset);

  const supportPaths = [...new Set(files.filter((file) => /\.dc\.html$/i.test(file.rel))
    .map((file) => path.posix.join(path.posix.dirname(file.rel), 'support.js')))];
  if (supportPaths.length) {
    try {
      const runtime = resolveFilePath(manifest.files, 'artifact-type/dc-runtime.js');
      const bytes = await fetchBytes(frameFileUrl(projectId, manifest.ver, runtime.path, manifest.assetToken), overrides.fetchImpl);
      for (const rel of supportPaths) assets.set(rel, { path: rel, bytes, contentType: 'text/javascript' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ path: 'support.js', error: message.replaceAll(encodeURIComponent(manifest.assetToken), '[redacted]') });
    }
  }

  const blobIds = new Set();
  for (const [rel, asset] of assets) {
    if (TEXT_FILE.test(rel)) for (const match of asset.bytes.toString('utf8').matchAll(BLOB_REFERENCE)) blobIds.add(match[1]);
  }
  const blobs = await Promise.all([...blobIds].map((id) => acquire(() => download(
    `_blob/${id}`, `${frameOrigin(projectId)}/_blob/${id}?__frame_t=${encodeURIComponent(manifest.assetToken)}`,
  ))));
  const blobPaths = new Set();
  for (const asset of blobs) {
    if (asset) { assets.set(asset.path, asset); blobPaths.add(asset.path); }
  }
  return { assets, errors, blobPaths };
}

export function rewriteArtifactBlobs(rel, asset, blobPaths) {
  if (!TEXT_FILE.test(rel) || rel.startsWith('_blob/')) return asset.bytes;
  const text = asset.bytes.toString('utf8').replace(BLOB_REFERENCE, (original, id) => {
    const blobPath = `_blob/${id}`;
    if (!blobPaths.has(blobPath)) return original;
    const relative = path.posix.relative(path.posix.dirname(rel), blobPath);
    return relative.startsWith('.') ? relative : `./${relative}`;
  });
  return Buffer.from(text, 'utf8');
}
