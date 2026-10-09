import { execFile } from 'node:child_process';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { expandHome, sanitizeName, sanitizeRelPath } from '../helpers.mjs';
import { DEFAULT_OUT } from '../pull.mjs';
import { getManifest, artifactSignature } from './manifest.mjs';
import { loadArtifactAssets, rewriteArtifactBlobs } from './assets.mjs';

const exec = promisify(execFile);

async function runZip(baseDir, safeName) {
  // Absolute destination and ./ input prevent titles beginning with '-' becoming options.
  await exec('/usr/bin/zip', ['-r', '-q', path.join(baseDir, `${safeName}.zip`), `./${safeName}`], { cwd: baseDir });
}

// Four positional arguments preserve T5's public contract; options also carries test DI.
export async function pullArtifact(scoped, design, outDir = DEFAULT_OUT, options = {}) {
  const manifest = await (options.getManifest || getManifest)(scoped, design.projectId, options);
  const baseDir = path.resolve(expandHome(outDir || DEFAULT_OUT));
  const safeName = sanitizeName(manifest.title || design.name);
  if (safeName === '.' || safeName === '..') throw new Error(`unsafe project name: ${safeName}`);
  const root = path.join(baseDir, safeName);
  await mkdir(root, { recursive: true });
  const { assets, errors, blobPaths } = await loadArtifactAssets(design.projectId, manifest, options);
  const files = [];
  for (const [rel, asset] of assets) {
    const safeRel = sanitizeRelPath(rel, root);
    const bytes = rewriteArtifactBlobs(rel, asset, blobPaths);
    try {
      const target = path.join(root, safeRel);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
      files.push({ path: rel, bytes: bytes.length });
    } catch (error) {
      errors.push({ path: rel, error: error instanceof Error ? error.message : String(error) });
    }
  }
  // Omit an unknown session rather than emitting null: consumers type sessionId as an optional string.
  const session = design.sessionId ? { sessionId: design.sessionId } : {};
  const project = { projectId: design.projectId, name: design.name, type: 'PROJECT_TYPE_PROJECT', ...session };
  const common = { project, backend: 'artifacts', ...session, ...(errors.length ? { errors } : {}) };
  if (options.zip === true) {
    await (options.runZip || runZip)(baseDir, safeName);
    const zipPath = path.join(baseDir, `${safeName}.zip`);
    return { ...common, dir: baseDir, files: [{ path: zipPath, bytes: (await stat(zipPath)).size }], signature: null };
  }
  return { ...common, dir: root, files, signature: artifactSignature(manifest.files), remoteUpdatedAt: manifest.updatedAt };
}
