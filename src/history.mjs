import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expandHome, sanitizeRelPath } from './helpers.mjs';
import { designBackend } from './backend.mjs';
import { text, flag, firstText } from './history-values.mjs';

export const HISTORY_SCHEMA_VERSION = 1;
export const DEFAULT_HISTORY_DIR = '~/.local/share/opencode-dashboard/claude-design-history';
export const HISTORY_FILE_NAME = 'events.ndjsonl';
export const REVISION_SCHEMA_VERSION = 1;
export const REVISIONS_DIR_NAME = '.revisions';
export const REVISION_META_NAME = '.meta.json';
const STAGING_PREFIX = '.staging-';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const CALLER_KEYS = ['directory', 'sessionID', 'agent', 'project'];
const SUBMIT_TOOLS = new Set(['design_create', 'design_iterate']);
const FOLLOW_UP_TOOLS = new Set(['design_check', 'design_pull']);

// projectId -> attemptId of the newest create/iterate submission in THIS process, so a later
// design_check/design_pull can be joined back to the prompt that started the generation.
const lastAttemptByProject = new Map();
let seq = 0;

export function historyDir() {
  const configured = String(process.env.CLAUDE_DESIGN_HISTORY_DIR || '').trim();
  return path.resolve(expandHome(configured || DEFAULT_HISTORY_DIR));
}

export function historyFile() {
  return path.join(historyDir(), HISTORY_FILE_NAME);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function warn(event, error) {
  process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), event, error: String(error?.message || error) })}\n`);
}

function errorText(error) {
  if (!error) return null;
  if (typeof error === 'string') return error;
  return text(error?.message) ?? String(error);
}

function normalizeCaller(value) {
  if (!isPlainObject(value)) return null;
  const caller = {};
  for (const key of CALLER_KEYS) {
    const found = text(value[key]);
    if (found !== null) caller[key] = found;
  }
  return Object.keys(caller).length ? caller : null;
}

// caller is transport metadata injected by the client, not a tool argument: the handler never sees it.
export function splitCallerArgs(rawArguments) {
  const args = rawArguments ?? {};
  if (!isPlainObject(args)) return { caller: null, rest: args };
  const { caller, ...rest } = args;
  return { caller: normalizeCaller(caller), rest };
}

// Whitelist only: file bytes, base64 payloads, and environment values must never reach the log.
function summarizeResult(result) {
  if (!isPlainObject(result)) return null;
  const summary = {};
  const sessionId = firstText(result.sessionId, result.project?.sessionId);
  if (sessionId !== null) summary.sessionId = sessionId;
  const backend = text(result.backend);
  if (backend !== null) summary.backend = backend;
  const projectId = firstText(result.projectId, result.project?.projectId);
  if (projectId !== null) summary.projectId = projectId;
  if (typeof result.reused === 'boolean') summary.reused = result.reused;
  if (typeof result.submitted === 'boolean') summary.submitted = result.submitted;
  if (typeof result.pending === 'boolean') summary.pending = result.pending;
  const status = text(result.status);
  if (status !== null) summary.status = status;
  if (Array.isArray(result.files)) summary.files = result.files.length;
  if (Array.isArray(result.errors)) summary.errors = result.errors.length;
  if (typeof result.signature === 'string') summary.signature = result.signature;
  if (typeof result.remoteUpdatedAt === 'string') summary.remoteUpdatedAt = result.remoteUpdatedAt;
  if (typeof result.timedOut === 'boolean') summary.timedOut = result.timedOut;
  const url = text(result.url);
  if (url !== null) summary.url = url;
  const dir = text(result.dir);
  if (dir !== null) summary.dir = dir;
  return Object.keys(summary).length ? summary : null;
}

// design_variants returns `variants`, not `projects`; keep each name so fan-out cards stay distinguishable.
function variantProjects(result) {
  if (!Array.isArray(result?.variants)) return null;
  return result.variants
    .filter((variant) => text(variant?.projectId) !== null)
    .map((variant) => ({ projectId: variant.projectId, name: text(variant.name) }));
}

function variantFailureNote(result) {
  if (!Array.isArray(result?.variants)) return null;
  const failed = result.variants.filter((variant) => text(variant?.projectId) === null).length;
  return failed ? `${failed}/${result.variants.length} variants failed` : null;
}

// Snapshot eligibility downstream keys off this field alone; zip wins when both zip and dir are set.
function pullKindOf(tool, args) {
  if (tool !== 'design_pull') return null;
  if (args.zip === true) return 'zip';
  return text(args.dir) === null ? 'default' : 'custom-dir';
}

function attemptIdFor(tool, projectId) {
  if (SUBMIT_TOOLS.has(tool)) {
    const attemptId = randomUUID();
    if (projectId !== null) lastAttemptByProject.set(projectId, attemptId);
    return attemptId;
  }
  if (FOLLOW_UP_TOOLS.has(tool) && projectId !== null) return lastAttemptByProject.get(projectId) ?? null;
  return null;
}

// One build per dispatched tools/call: it advances seq and mints the create/iterate attemptId.
export function buildToolEvent({ tool, args, caller = null, result = null, error = null, durationMs = null, revision = null } = {}) {
  const safeArgs = isPlainObject(args) ? args : {};
  const ok = !error;
  const projectId = firstText(safeArgs.projectId, result?.projectId, result?.project?.projectId);
  seq += 1;
  return {
    v: HISTORY_SCHEMA_VERSION,
    eventId: randomUUID(),
    seq,
    ts: new Date().toISOString(),
    tool: text(tool),
    durationMs: Number.isFinite(durationMs) ? Math.round(durationMs) : null,
    ok,
    error: ok ? variantFailureNote(result) : errorText(error),
    projectId,
    projects: variantProjects(result),
    projectName: firstText(safeArgs.name, result?.name, result?.project?.name),
    prompt: text(safeArgs.prompt),
    model: text(safeArgs.model),
    designSystem: text(safeArgs.designSystem),
    // The deliberate opt-out and its stated reason are part of the grounding decision, so they belong
    // in the same line as the system that would otherwise have been attached.
    withoutDesignSystem: flag(safeArgs.withoutDesignSystem),
    withoutDesignSystemReason: text(safeArgs.withoutDesignSystemReason),
    wait: flag(safeArgs.wait),
    attemptId: attemptIdFor(tool, projectId),
    caller: normalizeCaller(caller),
    pullKind: pullKindOf(tool, safeArgs),
    // Top level on purpose: the dashboard ingest reads `raw.revision`, so nesting it under
    // `result` would leave latest_revision/latest_complete_revision permanently NULL.
    revision: text(revision),
    // Only a successful call proves which backend owns the project: the dashboard copies these onto
    // the project row, so a failed call on a legacy standalone id must not relabel it as artifacts.
    backend: ok ? (text(result?.backend) ?? designBackend()) : null,
    sessionId: ok ? firstText(result?.sessionId, result?.project?.sessionId) : null,
    result: summarizeResult(result),
  };
}

export function recordToolEvent(event) {
  try {
    const line = JSON.stringify(event);
    if (typeof line !== 'string') throw new Error('event is not serializable');
    const dir = historyDir();
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    // O_APPEND single write: concurrent appenders never interleave a half line.
    appendFileSync(path.join(dir, HISTORY_FILE_NAME), `${line}\n`, { encoding: 'utf8', mode: FILE_MODE, flag: 'a' });
    return true;
  } catch (error) {
    // History is observability, never a precondition: warn on stderr and let the tool response through.
    warn('history.write_failed', error);
    return false;
  }
}

export function recordToolCall(input) {
  try {
    const event = buildToolEvent(input);
    return recordToolEvent(event) ? event : null;
  } catch (error) {
    warn('history.build_failed', error);
    return null;
  }
}

// `<YYYYMMDDTHHmmssSSS>-<uuid8>`: milliseconds plus a random suffix so two pulls in the same
// second cannot collide, while plain lexicographic sort still yields chronological order.
function newRevisionId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.(\d{3})Z$/, '$1');
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

// The id becomes a directory name, and projectId can originate from a tool argument.
function revisionProjectKey(projectId) {
  const key = text(projectId);
  return key !== null && /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(key) ? key : null;
}

// Manifest entries only: reading the pulled tree instead would snapshot files this pull never wrote.
function manifestDigests(dir, files) {
  const byPath = new Map();
  for (const file of files) {
    const rel = sanitizeRelPath(file?.path, dir); // rejects absolute paths and ../ escapes
    if (byPath.has(rel)) continue;
    const bytes = readFileSync(path.join(dir, rel));
    byPath.set(rel, { path: rel, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), body: bytes });
  }
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// One hash over every (path, sha256) pair: equal aggregates mean every file matched.
function aggregateHash(entries) {
  const digest = createHash('sha256');
  for (const entry of entries) digest.update(`${entry.path}\0${entry.sha256}\n`);
  return digest.digest('hex');
}

// Only the newest revision is compared; an unreadable one falls back to "snapshot anyway"
// so a half-written directory can never suppress a good snapshot.
function previousMeta(projectRoot) {
  try {
    const names = readdirSync(projectRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')) // also drops .staging-*
      .map((entry) => entry.name)
      .sort();
    if (!names.length) return null;
    const meta = JSON.parse(readFileSync(path.join(projectRoot, names.at(-1), REVISION_META_NAME), 'utf8'));
    return typeof meta?.hash === 'string' ? meta : null;
  } catch {
    return null;
  }
}

// Post-processing for a successful design_pull: copies the manifest into
// `<CLAUDE_DESIGN_DIR>/.revisions/<projectId>/<revisionId>/`, which is a sibling of the pulled
// tree so a snapshot can never recurse into itself. Returns the revisionId, or null when the
// content is unchanged or the snapshot failed - the pull result is never affected either way.
export function snapshotRevision({ projectId, dir, files = [], errors = [] } = {}) {
  const projectKey = revisionProjectKey(projectId);
  const pulledDir = text(dir);
  if (projectKey === null || pulledDir === null) return null;
  const source = path.resolve(expandHome(pulledDir));
  const projectRoot = path.join(path.dirname(source), REVISIONS_DIR_NAME, projectKey);
  const revisionId = newRevisionId();
  const staging = path.join(projectRoot, `${STAGING_PREFIX}${revisionId}`);
  try {
    const entries = manifestDigests(source, Array.isArray(files) ? files : []);
    const hash = aggregateHash(entries);
    const incomplete = (Array.isArray(errors) ? errors.length : 0) > 0;
    const previous = previousMeta(projectRoot);
    // Completeness is part of the identity: an incomplete -> complete flip over identical bytes
    // must still mint a revision, otherwise latest_complete_revision stays empty forever.
    if (previous && previous.hash === hash && previous.incomplete === incomplete) return null;
    mkdirSync(staging, { recursive: true, mode: DIR_MODE });
    for (const entry of entries) {
      const target = path.join(staging, entry.path);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, entry.body);
    }
    const meta = {
      v: REVISION_SCHEMA_VERSION,
      revisionId,
      projectId: projectKey,
      pullTs: new Date().toISOString(),
      fileCount: entries.length,
      hash,
      incomplete,
      errorCount: Array.isArray(errors) ? errors.length : 0,
      files: entries.map((entry) => ({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256 })),
    };
    writeFileSync(path.join(staging, REVISION_META_NAME), `${JSON.stringify(meta, null, 2)}\n`);
    renameSync(staging, path.join(projectRoot, revisionId)); // atomic: readers only ever see a finished revision
    return revisionId;
  } catch (error) {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      // a leftover .staging-* dir is filtered out of every listing, so it is not worth failing over
    }
    warn('history.snapshot_failed', error);
    return null;
  }
}

// Snapshot eligibility rides on pullKind alone: zip writes an archive and custom-dir writes
// outside the artifacts root, so neither can be served as a revision.
export function snapshotForToolCall({ tool, args, result, error = null } = {}) {
  if (tool !== 'design_pull' || error || !isPlainObject(result)) return null;
  const safeArgs = isPlainObject(args) ? args : {};
  if (pullKindOf(tool, safeArgs) !== 'default') return null;
  return snapshotRevision({
    // Same precedence as buildToolEvent: the directory name must match the event's projectId
    // or the viewer cannot find the revisions of the project it is showing.
    projectId: firstText(safeArgs.projectId, result.projectId, result.project?.projectId),
    dir: result.dir,
    files: result.files,
    errors: result.errors,
  });
}
