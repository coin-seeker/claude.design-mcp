const OMELETTE_BASE = 'https://claude.ai/design/anthropic.omelette.api.v1alpha.OmeletteService';

export function buildOmeletteExpression(method, body = {}, org = null) {
  return `(async () => {
    const base = ${JSON.stringify(OMELETTE_BASE)};
    const method = ${JSON.stringify(method)};
    const org = ${JSON.stringify(org)};
    const headers = { 'content-type': 'application/json', 'connect-protocol-version': '1' };
    if (org) headers['x-organization-uuid'] = org;
    const response = await fetch(base + '/' + method, { method: 'POST', headers, credentials: 'include', body: JSON.stringify(${JSON.stringify(body || {})}) });
    const text = await response.text();
    try { return JSON.parse(text); } catch (error) { void error; return { __status: response.status, __text: text.slice(0, 500) }; }
  })()`;
}

export function cookieOrgExpression() {
  return `(() => { const match = document.cookie.match(/lastActiveOrg=([^;]+)/); return match ? decodeURIComponent(match[1]) : null; })()`;
}

export function downloadZipExpression(projectId) {
  return `(async () => {
    const response = await fetch('https://claude.ai/design/v1/design/projects/' + ${JSON.stringify(projectId)} + '/download', { credentials: 'include' });
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return { ok: response.ok, status: response.status, contentType: response.headers.get('content-type'), content: btoa(binary) };
  })()`;
}

export async function omelette(page, method, body = {}, org = null) {
  const r = await page.evaluate(buildOmeletteExpression(method, body, org));
  if (r?.__status) throw new Error(method + ' HTTP ' + r.__status + ': ' + String(r.__text || '').slice(0, 200));
  return r;
}
