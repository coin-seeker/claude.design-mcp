const OMELETTE_BASE = 'https://claude.ai/design/anthropic.omelette.api.v1alpha.OmeletteService';
const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const DEFAULT_ZIP_TIMEOUT_MS = 180_000;

export function rpcTimeoutMs(fallbackMs) {
  const raw = Number(process.env.CLAUDE_DESIGN_RPC_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : fallbackMs;
}

export function buildOmeletteExpression(method, body = {}, org = null, options = {}) {
  const configuredTimeoutMs = rpcTimeoutMs(DEFAULT_RPC_TIMEOUT_MS);
  const requestedTimeoutMs = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
    ? Math.floor(requestedTimeoutMs)
    : configuredTimeoutMs;
  return `(async () => {
    const base = ${JSON.stringify(OMELETTE_BASE)};
    const method = ${JSON.stringify(method)};
    const org = ${JSON.stringify(org)};
    const headers = { 'content-type': 'application/json', 'connect-protocol-version': '1' };
    if (org) headers['x-organization-uuid'] = org;
    let response;
    try {
      response = await fetch(base + '/' + method, { method: 'POST', headers, credentials: 'include', body: JSON.stringify(${JSON.stringify(body || {})}), signal: AbortSignal.timeout(${timeoutMs}) });
    } catch (error) {
      if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new Error('RPC timed out: ' + method);
      throw error;
    }
    const text = await response.text();
    try { return JSON.parse(text); } catch (error) { void error; return { __status: response.status, __text: text.slice(0, 500) }; }
  })()`;
}

export function cookieOrgExpression() {
  return `(() => { const match = document.cookie.match(/lastActiveOrg=([^;]+)/); return match ? decodeURIComponent(match[1]) : null; })()`;
}

export function downloadZipExpression(projectId) {
  return `(async () => {
    const projectId = ${JSON.stringify(projectId)};
    let response;
    try {
      response = await fetch('https://claude.ai/design/v1/design/projects/' + projectId + '/download', { credentials: 'include', signal: AbortSignal.timeout(${rpcTimeoutMs(DEFAULT_ZIP_TIMEOUT_MS)}) });
    } catch (error) {
      if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new Error('RPC timed out: downloadZip ' + projectId);
      throw error;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return { ok: response.ok, status: response.status, contentType: response.headers.get('content-type'), content: btoa(binary) };
  })()`;
}

export async function omelette(page, method, body = {}, org = null, options = {}) {
  const r = await page.evaluate(buildOmeletteExpression(method, body, org, options));
  if (r?.__status) throw new Error(method + ' HTTP ' + r.__status + ': ' + String(r.__text || '').slice(0, 200));
  return r;
}
