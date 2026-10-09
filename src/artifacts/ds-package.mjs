import { lstat, readdir, readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expandHome } from '../helpers.mjs';

const zip = promisify(execFile);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function systemTitle(pkg) {
  const match = typeof pkg.description === 'string' && /^(.*\S)\s+design system$/i.exec(pkg.description.trim());
  if (match) return `${match[1]} Design System`;
  if (typeof pkg.name !== 'string' || !pkg.name.trim()) throw new TypeError('package.json requires a name or design system description');
  return `${pkg.name.trim()} Design System`;
}

export async function readPackage(directory) {
  if (typeof directory !== 'string' || !directory.trim()) throw new TypeError('dir is required');
  const dir = path.resolve(expandHome(directory));
  const files = [];
  async function walk(rel = '') {
    for (const name of (await readdir(path.join(dir, rel))).sort()) {
      if (name.startsWith('.') || name === 'node_modules' || name === 'ds-bundle') continue;
      const relative = path.posix.join(rel, name);
      const stat = await lstat(path.join(dir, relative));
      if (stat.isDirectory()) await walk(relative);
      else if (stat.isFile()) {
        const bytes = await readFile(path.join(dir, relative));
        files.push({ path: relative, bytes, sha256: createHash('sha256').update(bytes).digest('hex') });
      }
    }
  }
  // Required files must be regular files, never symlinks.
  for (const required of ['package.json', 'styles.css']) {
    try {
      if (!(await lstat(path.join(dir, required))).isFile()) throw new Error(`${required} not found in ${dir}`);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new Error(`${required} not found in ${dir}`);
      throw error;
    }
  }
  await walk();
  const metadata = JSON.parse(files.find((file) => file.path === 'package.json').bytes.toString('utf8'));
  if (!record(metadata)) throw new TypeError('Invalid package.json');
  let artifactId = null;
  try {
    const configDir = path.join(dir, '.design-sync');
    const configPath = path.join(configDir, 'config.json');
    if ((await lstat(configDir)).isDirectory() && (await lstat(configPath)).isFile()) {
      const config = JSON.parse(await readFile(configPath, 'utf8'));
      if (record(config) && typeof config.artifactId === 'string' && uuid.test(config.artifactId)) artifactId = config.artifactId;
    }
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  return { dir, title: systemTitle(metadata), artifactId, files };
}

export function targetPath(rel) {
  if (rel === 'package.json' || rel.toLowerCase() === 'readme.md') return null;
  return rel === 'manifest.json' ? 'docs/manifest.json' : rel;
}

export function verbatimFiles(pkg) {
  return pkg.files.filter((file) => targetPath(file.path) !== null).map((file) => ({ ...file, target: targetPath(file.path) }));
}

export async function zipPackage(pkg) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'claude-ds-sync-'));
  const cleanup = () => rm(temporary, { recursive: true, force: true });
  const root = path.join(temporary, 'package');
  const zipPath = path.join(temporary, 'design-system-package.zip');
  try {
    // Archive exactly the hashed snapshot: no symlink following or walk/zip exclusion drift.
    for (const file of pkg.files) {
      const destination = path.join(root, file.path);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, file.bytes);
    }
    await zip('/usr/bin/zip', ['-qr', zipPath, '.'], { cwd: root });
    return { path: zipPath, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export function buildSyncPrompt({ title, created, verbatim }) {
  return [
    'Sync the attached materialized design-system package. This is unattended: do not ask questions or request confirmation; complete the sync now.',
    'Unzip the attachment in your working folder. Follow this Design System artifact\'s SKILL.md and format.md.',
    created ? 'Follow Creating to create this design system.' : 'Follow Revising to re-sync this design system file by file.',
    'Publish EACH file listed below byte-for-byte to its project/ target using the Artifact tool with root and files mapping. Never retype file contents and never use base64.',
    ...verbatim.map((file) => `- ${JSON.stringify(file.path)} -> ${JSON.stringify(`project/${file.target ?? targetPath(file.path)}`)}`),
    'Write project/README.md from readme.md (or README.md), preserving the brand book and the author\'s words.',
    'Write project/tokens.json in the required list shape, converting tokens/tokens.json according to format.md (color.tokens must be a non-empty array when the source has colors).',
    'Keep all other existing files. Do not write page-generated manifest.json, tokens.css, or api/ files; do not publish dot-files or toolchain files.',
    'If the existing project/design-system.json has editing or source keys, this is Finish the migration: follow that SKILL.md clean-up and remove both keys in the final index call.',
    `Write project/design-system.json LAST with title exactly ${JSON.stringify(title)} and lastChange.via = "opencode-dashboard sync".`,
    'Publish the finished artifact and reply with one line when done.',
  ].join('\n');
}

// Positional signature is the approved package verification contract.
export async function verifySync(manifestFiles, pkg, title, readIndexTitle, readTokens) {
  const remote = new Map(manifestFiles.map((file) => [file.path, file]));
  const mismatched = [];
  let files = 0;
  for (const file of verbatimFiles(pkg)) {
    const target = `project/${file.target}`;
    if (remote.get(target)?.sha256 !== file.sha256) mismatched.push(target);
    else files++;
  }
  if (!remote.has('project/README.md')) mismatched.push('project/README.md');
  if (!remote.has('project/design-system.json') || await readIndexTitle() !== title) mismatched.push('project/design-system.json');
  const source = pkg.files.find((file) => file.path === 'tokens/tokens.json');
  const tokens = source ? JSON.parse(source.bytes.toString('utf8')) : null;
  const colors = tokens?.color ?? tokens?.colors ?? tokens?.tokens?.color ?? tokens?.tokens?.colors;
  if (colors && Object.keys(colors).length) {
    const published = remote.has('project/tokens.json') ? await readTokens() : null;
    if (!record(published) || !Array.isArray(published.color?.tokens) || !published.color.tokens.length) mismatched.push('project/tokens.json');
  }
  return { files, mismatched };
}
