import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { expandHome } from './helpers.mjs';

export const HISTORY_SCHEMA_VERSION = 1;
export const DEFAULT_HISTORY_DIR = '~/.local/share/opencode-dashboard/claude-design-history';
export const HISTORY_FILE_NAME = 'events.ndjsonl';
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

function text(value) {
  return typeof value === 'string' && value ? value : null;
}

function flag(value) {
  return typeof value === 'boolean' ? value : null;
}

function firstText(...values) {
  for (const value of values) {
    const found = text(value);
    if (found !== null) return found;
  }
  return null;
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
  const projectId = firstText(result.projectId, result.project?.projectId);
  if (projectId !== null) summary.projectId = projectId;
  if (typeof result.reused === 'boolean') summary.reused = result.reused;
  if (typeof result.submitted === 'boolean') summary.submitted = result.submitted;
  if (typeof result.pending === 'boolean') summary.pending = result.pending;
  const status = text(result.status);
  if (status !== null) summary.status = status;
  if (Array.isArray(result.files)) summary.files = result.files.length;
  if (Array.isArray(result.errors)) summary.errors = result.errors.length;
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
export function buildToolEvent({ tool, args, caller = null, result = null, error = null, durationMs = null } = {}) {
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
    wait: flag(safeArgs.wait),
    attemptId: attemptIdFor(tool, projectId),
    caller: normalizeCaller(caller),
    pullKind: pullKindOf(tool, safeArgs),
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
    process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), event: 'history.write_failed', error: String(error?.message || error) })}\n`);
    return false;
  }
}

export function recordToolCall(input) {
  try {
    const event = buildToolEvent(input);
    return recordToolEvent(event) ? event : null;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), event: 'history.build_failed', error: String(error?.message || error) })}\n`);
    return null;
  }
}
