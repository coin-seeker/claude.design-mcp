// Runs Claude Code's `/design-sync` inside an already-materialized design-system package
// directory and uploads it to claude.ai/design.
//
// The caller owns `.design-sync/config.json`: that generated file pins re-runs to the same
// Claude project, and any flow that REPLACES the package directory (the dashboard
// materializer does a temp-dir + rm -rf + rename) must snapshot `.design-sync/` before the
// replacement and restore it afterwards, or the next sync creates a duplicate project
// instead of a pinned no-op. This runner never writes the package; it only runs the command
// in the directory it is given.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { expandHome } from './helpers.mjs';
import { listDesignSystems } from './list-systems.mjs';
import { writeProjectTextFile } from './project-file.mjs';

export const DEFAULT_SYNC_TIMEOUT_MS = 15 * 60 * 1000;
// `claude -p` has no `AskUserQuestion` tool, so every confirmation the `/design-sync` skill asks for
// is unanswerable here: the turn ends with the question and nothing uploads. That is invisible on a
// re-sync (a `.design-sync/` pin skips both gates) and deterministic on a first-time sync, which asks
// twice — once to accept the time/cost, once to confirm the new project's name before create_project.
// The skill documents the way out ("If their request already acknowledged the time/cost, note that and
// continue without re-asking"), so the prompt pre-approves both gates up front. Claude Code appends
// everything after the slash command to the skill body as a fenced `## Hint` block, so this must stay
// ONE positional string (a second array element would be parsed as a flag, not as prompt text) and must
// never contain a triple backtick, which would close that fence early.
export const SYNC_PREAPPROVAL = 'This is an unattended headless run: AskUserQuestion is unavailable, so do not ask anything and do not wait for an answer — a question ends the run without syncing. The time and token cost of a full high-fidelity import is already acknowledged and accepted, so skip the proceed confirmation and continue. Creating a new pinned claude.ai project is pre-approved when this package has no existing .design-sync pin: pick a non-colliding name yourself, call create_project without confirming the name first, and continue through the upload without further approval.';
export const SYNC_ARGS = ['-p', `/design-sync ${SYNC_PREAPPROVAL}`, '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'];

const PROJECT_URL_RE = /https?:\/\/claude\.ai\/design\/p\/([0-9a-zA-Z-]{20,})/;
// `/design-sync` writes the system name in prose, either right after the project link
// (`…/p/<id>** ("Frontend Design System", 신규 생성)`) or ahead of it on a re-sync
// (`핀된 프로젝트 **"Frontend Design System"** … 프로젝트: <url>`), so try the link first
// and fall back to the first name-shaped quoted phrase in the reply.
const NAME_AFTER_URL_RE = /^[^"\u201c\n]{0,40}["\u201c]([^"\u201d\n]{1,80})["\u201d]/;
const QUOTED_RE = /["\u201c]([^"\u201d\n]{2,80})["\u201d]/gu;
const NAME_NOISE_RE = /[\\/={}<>]/u;
const RAW_MAX_CHARS = 20_000;
const TOKEN_IMPORT_RE = /^@import\s+["']\.\/tokens\/tokens\.json["']\s*;/u;
const IMPORT_LINE_RE = /^@import\s+(?:url\()?\s*["'][^"']+["']\s*\)?\s*;$/u;

function tailOf(text) {
  const value = String(text ?? '');
  return value.length > RAW_MAX_CHARS ? value.slice(-RAW_MAX_CHARS) : value;
}

function parseJsonOrNull(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// `claude -p` prints startup warnings before the JSON result, so scan backwards for the payload line.
export function parseClaudeJson(stdout) {
  const lines = String(stdout ?? '').split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    const parsed = parseJsonOrNull(line);
    if (parsed) return parsed;
  }
  return null;
}

function parseClaudeResult(stdout) {
  const lines = String(stdout ?? '').split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parsed = parseJsonOrNull(lines[index].trim());
    if (parsed?.type === 'result') return parsed;
  }
  return null;
}

function systemNameFrom(text, afterUrl) {
  const linked = NAME_AFTER_URL_RE.exec(afterUrl);
  if (linked) return linked[1].trim();
  for (const match of text.matchAll(QUOTED_RE)) {
    const before = text.slice(0, match.index);
    const insideCodeSpan = (before.match(/`+/gu)?.length ?? 0) % 2 === 1;
    if (insideCodeSpan || /@import\s*$/u.test(before)) continue;
    const quoted = match[1];
    const candidate = quoted.trim();
    if (candidate && !NAME_NOISE_RE.test(candidate) && /\p{L}/u.test(candidate)) return candidate;
  }
  return null;
}

async function lookupDesignSystemName(projectId) {
  const systems = await listDesignSystems();
  return systems.find((system) => system.id === projectId)?.name ?? null;
}

async function resolveSystemName(projectId, fallback, lookupSystemName) {
  try {
    const resolved = String(await lookupSystemName(projectId) ?? '').trim();
    return resolved || fallback;
  } catch {
    return fallback;
  }
}

export function extractProject(payload) {
  const resultText = typeof payload?.result === 'string' ? payload.result : '';
  const match = PROJECT_URL_RE.exec(resultText) || PROJECT_URL_RE.exec(JSON.stringify(payload ?? null));
  if (!match) return null;
  const searched = match.input;
  return { projectId: match[1], url: match[0], systemName: systemNameFrom(searched, searched.slice(match.index + match[0].length)) };
}

// PROTOCOL R3: exit 0 and `subtype: "success"` prove nothing — the empty-directory spike run
// returned both while its result body refused to sync. Only a project URL/ID counts as an upload.
export function evaluateSyncOutput({ code, stdout, stderr }) {
  const raw = { code, stdout: tailOf(stdout), stderr: tailOf(stderr) };
  if (code !== 0) return { ok: false, error: `claude exited with non-zero status ${code}`, raw };
  const payload = parseClaudeResult(stdout) || parseClaudeJson(stdout);
  if (!payload) return { ok: false, error: 'claude produced no parsable JSON result', raw };
  if (payload.is_error === true) return { ok: false, error: `claude reported an error result (subtype ${payload.subtype ?? 'unknown'})`, raw };
  const project = extractProject(payload);
  if (!project) return { ok: false, error: 'sync completed but no project id was reported — /design-sync refused or uploaded nothing', raw };
  return { ok: true, systemName: project.systemName, projectId: project.projectId, url: project.url, raw };
}

export function resolveTimeoutMs(explicit, env = process.env) {
  const ms = Number(explicit ?? env.CLAUDE_DESIGN_SYNC_TIMEOUT_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_SYNC_TIMEOUT_MS;
}

export function isStylesShim(content) {
  const trimmed = String(content ?? '').trim();
  if (!trimmed) return false;
  if (TOKEN_IMPORT_RE.test(trimmed)) return true;
  return trimmed.split(/\r?\n/u).every((line) => IMPORT_LINE_RE.test(line.trim()));
}

export function stripLeadingThemeInline(content) {
  const source = String(content ?? '');
  const leading = /^\s*@theme\s+inline\s*\{/u.exec(source);
  if (!leading) return source;
  const open = source.indexOf('{', leading.index);
  let depth = 0;
  let quote = null;
  let inComment = false;
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (inComment) {
      if (char === '*' && next === '/') {
        inComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '*') {
      inComment = true;
      index += 1;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(index + 1).trimStart();
    }
  }
  return source;
}

export async function flattenSyncedStyles({ dir, projectId, onProgress, writeProjectFile = writeProjectTextFile }) {
  try {
    const bundleDir = path.join(dir, 'ds-bundle');
    const styles = await readFile(path.join(bundleDir, 'styles.css'), 'utf8');
    if (!isStylesShim(styles)) {
      onProgress?.('flatten: skipped (ds-bundle/styles.css is not an import shim)');
      return { flattened: false };
    }
    const flattenedCss = stripLeadingThemeInline(await readFile(path.join(bundleDir, '_ds_bundle.css'), 'utf8'));
    await writeProjectFile({ projectId, path: 'styles.css', content: flattenedCss });
    onProgress?.(`flatten: styles.css → ${Buffer.byteLength(flattenedCss)} bytes`);
    return { flattened: true };
  } catch (error) {
    const flattenError = error instanceof Error ? error.message : String(error);
    onProgress?.(`flatten: failed (${flattenError})`);
    return { flattened: false, flattenError };
  }
}

export function defaultSpawn({ bin, args, cwd, signal, onProgress, spawnImpl = spawn }) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(bin, args, { cwd, signal, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let lineBuffer = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      lineBuffer += chunk;
      let newline;
      while ((newline = lineBuffer.indexOf('\n')) >= 0) {
        onProgress?.(lineBuffer.slice(0, newline));
        lineBuffer = lineBuffer.slice(newline + 1);
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (lineBuffer) onProgress?.(lineBuffer);
      resolve({ code, stdout, stderr });
    });
  });
}

// The abort kills the real child; the race also bounds an injected spawn that never settles.
async function withTimeout(run, timeoutMs) {
  const controller = new AbortController();
  let timer = null;
  const expiry = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`/design-sync timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), expiry]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runDesignSync({ dir, timeoutMs, onProgress, spawnImpl = defaultSpawn, writeProjectFile = writeProjectTextFile, lookupSystemName = lookupDesignSystemName, env = process.env } = {}) {
  const requested = String(dir ?? '').trim();
  if (!requested) throw new Error('dir is required');
  const target = path.resolve(expandHome(requested));
  if (!existsSync(path.join(target, 'package.json'))) {
    return { dir: target, ok: false, flattened: false, error: `package.json not found in ${target} — /design-sync needs a materialized package directory`, raw: null };
  }
  const bin = String(env.CLAUDE_DESIGN_CLAUDE_BIN || 'claude');
  const limitMs = resolveTimeoutMs(timeoutMs, env);
  const outcome = await withTimeout(
    (signal) => spawnImpl({ bin, args: SYNC_ARGS, cwd: target, timeoutMs: limitMs, signal, onProgress }),
    limitMs,
  );
  const synced = { dir: target, ...evaluateSyncOutput(outcome) };
  if (!synced.ok) return { ...synced, flattened: false };
  synced.systemName = await resolveSystemName(synced.projectId, synced.systemName, lookupSystemName);
  const flattened = await flattenSyncedStyles({ dir: target, projectId: synced.projectId, onProgress, writeProjectFile });
  return { ...synced, ...flattened };
}
