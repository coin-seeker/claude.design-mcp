export function logEvent(event, fields = {}) {
  process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields })}\n`);
}

export async function closePage(page, reason) {
  const url = typeof page.url === 'function' ? page.url() : '';
  logEvent('page.close', { reason, url });
  try {
    await page.close();
  } catch (error) {
    logEvent('page.close_failed', { reason, url, error: String(error?.message || error) });
  }
}
