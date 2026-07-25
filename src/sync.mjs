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
import path from 'node:path';

import { expandHome } from './helpers.mjs';

export const DEFAULT_SYNC_TIMEOUT_MS = 15 * 60 * 1000;
export const SYNC_ARGS = ['-p', '/design-sync', '--dangerously-skip-permissions', '--output-format', 'json'];

const PROJECT_URL_RE = /https?:\/\/claude\.ai\/design\/p\/([0-9a-zA-Z-]{20,})/;
// `/design-sync` writes the system name in prose, either right after the project link
// (`…/p/<id>** ("Frontend Design System", 신규 생성)`) or ahead of it on a re-sync
// (`핀된 프로젝트 **"Frontend Design System"** … 프로젝트: <url>`), so try the link first
// and fall back to the first name-shaped quoted phrase in the reply.
const NAME_AFTER_URL_RE = /^[^"\u201c\n]{0,40}["\u201c]([^"\u201d\n]{1,80})["\u201d]/;
const QUOTED_RE = /["\u201c]([^"\u201d\n]{2,80})["\u201d]/gu;
const NAME_NOISE_RE = /[\\/={}<>]/u;
const RAW_MAX_CHARS = 20_000;

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

function systemNameFrom(text, afterUrl) {
  const linked = NAME_AFTER_URL_RE.exec(afterUrl);
  if (linked) return linked[1].trim();
  for (const [, quoted] of text.matchAll(QUOTED_RE)) {
    const candidate = quoted.trim();
    if (candidate && !NAME_NOISE_RE.test(candidate) && /\p{L}/u.test(candidate)) return candidate;
  }
  return null;
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
  const payload = parseClaudeJson(stdout);
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

function defaultSpawn({ bin, args, cwd, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, signal, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
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

export async function runDesignSync({ dir, timeoutMs, spawnImpl = defaultSpawn, env = process.env } = {}) {
  const requested = String(dir ?? '').trim();
  if (!requested) throw new Error('dir is required');
  const target = path.resolve(expandHome(requested));
  if (!existsSync(path.join(target, 'package.json'))) {
    return { dir: target, ok: false, error: `package.json not found in ${target} — /design-sync needs a materialized package directory`, raw: null };
  }
  const bin = String(env.CLAUDE_DESIGN_CLAUDE_BIN || 'claude');
  const limitMs = resolveTimeoutMs(timeoutMs, env);
  const outcome = await withTimeout(
    (signal) => spawnImpl({ bin, args: SYNC_ARGS, cwd: target, timeoutMs: limitMs, signal }),
    limitMs,
  );
  return { dir: target, ...evaluateSyncOutput(outcome) };
}
