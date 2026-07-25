const pageIds = new WeakMap();
let nextPageId = 1;

export function pageIdentity(page) {
  if (!page || (typeof page !== 'object' && typeof page !== 'function')) return null;
  let pageId = pageIds.get(page);
  if (!pageId) {
    pageId = `page-${nextPageId}`;
    nextPageId += 1;
    pageIds.set(page, pageId);
  }
  return pageId;
}

export function logEvent(event, fields = {}) {
  process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields })}\n`);
}

export async function closePage(page, reason, fields = {}) {
  const url = typeof page.url === 'function' ? page.url() : '';
  const pageId = pageIdentity(page);
  logEvent('page.close', { reason, pageId, url, ...fields });
  try {
    await page.close();
  } catch (error) {
    logEvent('page.close_failed', { reason, pageId, url, error: String(error?.message || error) });
  }
}
