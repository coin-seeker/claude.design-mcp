import { NotLoggedInError, loginHelp } from '../session.mjs';
import { rpcTimeoutMs } from '../rpc.mjs';

// Serialized by Playwright: this function must not close over module bindings.
export async function browserFetch({ url, method = 'GET', headers = {}, body, timeoutMs = 30_000 }) {
  const response = await fetch(url, {
    method, headers, credentials: 'include',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  return { status: response.status, json, text: text.slice(0, 500) };
}

export class ArtifactsHttpError extends Error {
  constructor(status, path, detail) {
    super(`Artifacts HTTP ${status}: ${path}${detail ? `: ${detail}` : ''}`);
    this.name = 'ArtifactsHttpError';
    this.status = status;
    this.path = path;
  }
}

async function request(scoped, path, options) {
  const result = await scoped.page.evaluate(browserFetch, {
    url: `https://claude.ai${path}`,
    ...options,
    headers: { ...options.headers, ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) },
    timeoutMs: rpcTimeoutMs(30_000),
  });
  if (result.status === 401 || result.status === 403) {
    throw new NotLoggedInError(loginHelp(`HTTP ${result.status}: ${path}`));
  }
  if (result.status < 200 || result.status >= 300) {
    throw new ArtifactsHttpError(result.status, path.split('?')[0], result.text);
  }
  return result.json;
}

// Four arguments preserve the foundation contract used by subsequent adapters.
export function frameRequest(scoped, method, pathAndQuery, body) {
  const path = `${pathAndQuery}${pathAndQuery.includes('?') ? '&' : '?'}org=${encodeURIComponent(scoped.org)}`;
  return request(scoped, path, {
    method, body,
    headers: { 'x-frame-platform': 'web', 'x-frame-surface': 'cowork', 'x-frame-cp': 'go' },
  });
}

// Non-GET calls send an empty JSON body, as the web app does for DELETE /v1/code/sessions/<cse>.
export async function ccrRequest(scoped, path, method = 'GET') {
  const result = await request(scoped, path, {
    method,
    ...(method === 'GET' ? {} : { body: {} }),
    headers: {
      'anthropic-beta': 'ccr-byoc-2025-07-29',
      'anthropic-version': '2023-06-01',
      'x-organization-uuid': scoped.org,
    },
  });
  // Session GETs are wrapped; event pages retain data/next_cursor unchanged.
  return result?.response_shape ?? result;
}

// T0 verified migration auth is credentials-only (not CCR headers).
export function designApiRequest(scoped, method, path, body) {
  return request(scoped, path, { method, body, headers: {} });
}

export function frameOrigin(artifactId) {
  return `https://${artifactId}.frame.claudeusercontent.com`;
}

// Keep the public positional signature specified by T2 for file consumers.
export function frameFileUrl(artifactId, ver, path, assetToken) {
  const encodedPath = path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return `${frameOrigin(artifactId)}/_f/${encodeURIComponent(ver)}/${encodedPath}?__frame_t=${encodeURIComponent(assetToken)}`;
}
