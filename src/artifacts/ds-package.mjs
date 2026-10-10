import { lstat, readdir, readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expandHome } from '../helpers.mjs';
import { currentAccount } from '../accounts.mjs';

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
  // Required files must be regular files, never symlinks. A native package carries its stylesheet
  // as components/bundle.css instead of the standalone deck's root styles.css.
  const isRegularFile = async (rel) => {
    try { return (await lstat(path.join(dir, rel))).isFile(); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
      throw error;
    }
  };
  if (!(await isRegularFile('package.json'))) throw new Error(`package.json not found in ${dir}`);
  if (!(await isRegularFile('styles.css')) && !(await isRegularFile('components/bundle.css'))) throw new Error(`styles.css or components/bundle.css not found in ${dir}`);
  await walk();
  const metadata = JSON.parse(files.find((file) => file.path === 'package.json').bytes.toString('utf8'));
  if (!record(metadata)) throw new TypeError('Invalid package.json');
  let artifactId = null;
  let remove = [];
  try {
    const configDir = path.join(dir, '.design-sync');
    const configPath = path.join(configDir, 'config.json');
    if ((await lstat(configDir)).isDirectory() && (await lstat(configPath)).isFile()) {
      const config = JSON.parse(await readFile(configPath, 'utf8'));
      const pin = record(config) ? (currentAccount() === 'main' ? config.artifactId : config.artifactIds?.sub) : null;
      if (typeof pin === 'string' && uuid.test(pin)) artifactId = pin;
      if (record(config) && config.remove !== undefined) remove = removalPaths(config.remove);
    }
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const published = new Set(['README.md', 'design-system.json', ...files.map((file) => targetPath(file.path)).filter(Boolean)]);
  const clash = remove.find((item) => published.has(item));
  if (clash) throw new TypeError(`remove path is also published by this package: ${clash}`);
  return { dir, title: systemTitle(metadata), artifactId, files, remove, bundle: bundleHeader(files) };
}

// Obsolete remote files a re-sync deletes; only plain relative paths are accepted.
function removalPaths(value) {
  if (!Array.isArray(value)) throw new TypeError('.design-sync/config.json remove must be an array of paths');
  return value.map((item) => {
    if (typeof item !== 'string' || !item || item.startsWith('/') || item.includes('\\') || item.split('/').some((part) => part === '..' || part === '' || part.startsWith('.'))) {
      throw new TypeError(`Invalid remove path in .design-sync/config.json: ${JSON.stringify(item)}`);
    }
    return item;
  });
}

// components/bundle.js line 1: /* @ds-bundle: {"format":4,"namespace":"…","components":[…]} */
function bundleHeader(files) {
  const bundle = files.find((file) => file.path === 'components/bundle.js');
  if (!bundle) return null;
  const match = /^\/\*\s*@ds-bundle:\s*(\{.*\})\s*\*\//.exec(bundle.bytes.toString('utf8').split('\n', 1)[0]);
  if (!match) throw new TypeError('components/bundle.js line 1 must be a /* @ds-bundle: {...} */ header');
  let header;
  try { header = JSON.parse(match[1]); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new TypeError(`components/bundle.js @ds-bundle header is not valid JSON: ${error.message}`);
  }
  if (typeof header.namespace !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(header.namespace)) throw new TypeError('components/bundle.js header needs a JS identifier namespace');
  return { namespace: header.namespace };
}

// Prompt options derived from the package; absent for a standalone deck, so its prompt is unchanged.
export function syncPromptOptions(pkg) {
  return { remove: pkg.remove ?? [], bundle: pkg.bundle ?? null, listTokens: pkg.files.some((file) => file.path === 'tokens.json') };
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

export const BUNDLE_LIBRARIES = [{ name: 'react', version: '18' }, { name: 'react-dom', version: '18' }];

export function buildSyncPrompt({ title, created, verbatim, remove = [], bundle = null, listTokens = false }) {
  return [
    'Sync the attached materialized design-system package. This is unattended: do not ask questions or request confirmation; complete the sync now.',
    'Unzip the attachment in your working folder. Follow this Design System artifact\'s SKILL.md and format.md.',
    created ? 'Follow Creating to create this design system.' : 'Follow Revising to re-sync this design system file by file.',
    'Publish EACH file listed below byte-for-byte to its project/ target using the Artifact tool with root and files mapping. Never retype file contents and never use base64.',
    ...verbatim.map((file) => `- ${JSON.stringify(file.path)} -> ${JSON.stringify(`project/${file.target ?? targetPath(file.path)}`)}`),
    'Write project/README.md from readme.md (or README.md), preserving the brand book and the author\'s words.',
    listTokens
      ? 'project/tokens.json is published verbatim above: it is already in the required list shape, so do not convert or rewrite it.'
      : 'Write project/tokens.json in the required list shape, converting tokens/tokens.json according to format.md (color.tokens must be a non-empty array when the source has colors).',
    ...(remove.length ? [
      'Remove each of these obsolete files by sending it as "project/<path>": null in a files mapping:',
      ...remove.map((file) => `- ${JSON.stringify(`project/${file}`)}`),
      'In the index, drop every docs.sections entry that names one of those removed paths.',
      'Keep every other existing file. Do not write page-generated manifest.json, tokens.css, or api/ files; do not publish dot-files or toolchain files.',
    ] : ['Keep all other existing files. Do not write page-generated manifest.json, tokens.css, or api/ files; do not publish dot-files or toolchain files.']),
    'If the existing project/design-system.json has editing or source keys, this is Finish the migration: follow that SKILL.md clean-up and remove both keys in the final index call.',
    bundle
      ? `Write project/design-system.json LAST with title exactly ${JSON.stringify(title)}, namespace exactly ${JSON.stringify(bundle.namespace)} (the bundle's global), libraries exactly ${JSON.stringify(BUNDLE_LIBRARIES)}, and lastChange.via = "opencode-dashboard sync".`
      : `Write project/design-system.json LAST with title exactly ${JSON.stringify(title)} and lastChange.via = "opencode-dashboard sync".`,
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
  for (const file of pkg.remove ?? []) if (remote.has(`project/${file}`)) mismatched.push(`project/${file}`);
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
