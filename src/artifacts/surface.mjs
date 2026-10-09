const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function designUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://claude.ai' ? url : null;
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

// Independent of the session path: failed navigation polling must still be able to clean up.
export function artifactIdFromUrl(value) {
  const id = designUrl(value)?.searchParams.get('artifact');
  return id && UUID.test(id) ? id : null;
}

export function parseDesignLocation(value) {
  const url = designUrl(value);
  const projectId = artifactIdFromUrl(value);
  if (!url || !projectId) return null;
  const cowork = /^\/cowork\/(cse_[A-Za-z0-9]+)$/.exec(url.pathname);
  if (cowork) return { surface: 'cowork', sessionId: cowork[1], chatId: null, projectId };
  const chat = /^\/chat\/([^/]+)$/.exec(url.pathname);
  if (chat && UUID.test(chat[1])) return { surface: 'chat', sessionId: null, chatId: chat[1], projectId };
  return null;
}
