import { setTimeout as delay } from 'node:timers/promises';
import { ensureSession } from '../session.mjs';
import { withRpcPage } from '../operation-pages.mjs';
import { ccrRequest, ArtifactsHttpError } from './api.mjs';
import { readIndex, updateEntry } from './index-store.mjs';
import { classifyArtifactTurn, readAllEvents, readTurnEvents, FINISHED_BUCKETS } from './turn.mjs';
import { readChatMessages, classifyChatTurn, findWorkspaceSessionId } from './chat-turn.mjs';

export { readAllEvents } from './turn.mjs';

// Lazy imports keep classifier/check tests independent of the concurrent T3 work.
const CHECK_DEPS = {
  delay,
  ensureSession,
  withRpcPage,
  ccrRequest,
  readIndex,
  updateEntry,
  findWorkspaceSessionId,
  readAllEvents,
  readTurnEvents,
  readChatMessages,
  resolveSessionId: async (scoped, id) => (await import('./listing.mjs')).resolveSessionId(scoped, id),
  readManifest: async (scoped, id) => (await import('./manifest.mjs')).getManifest(scoped, id),
  signature: async (files) => (await import('./manifest.mjs')).artifactSignature(files),
  now: Date.now,
};

export async function artifactsCheck(args = {}, overrides = {}) {
  const deps = { ...CHECK_DEPS, ...overrides };
  const projectId = String(args.projectId ?? '').trim();
  if (!projectId) throw new Error('projectId is required');
  try {
    return await checkOnce({ ...args, projectId }, deps);
  } catch (error) {
    if (error instanceof ArtifactsHttpError || error?.name === 'NotLoggedInError'
      || !/TimeoutError|signal timed out|Timeout \d+ms exceeded/.test(String(error?.message))) throw error;
    await deps.delay(2000);
    return checkOnce({ ...args, projectId }, deps);
  }
}

async function checkOnce(args, deps) {
  const { projectId } = args;
  const session = await deps.ensureSession({ visible: false });
  return deps.withRpcPage(session, async (page) => {
    const scoped = { ...session, page };
    const indexed = deps.readIndex().byArtifact[projectId];
    if (indexed?.surface === 'chat' && indexed.chatId) {
      const [messages, manifest] = await Promise.all([
        deps.readChatMessages(scoped, indexed.chatId, deps), deps.readManifest(scoped, projectId),
      ]);
      const signature = await deps.signature(manifest.files);
      let state;
      try {
        const workspaceSessionId = indexed.workspaceSessionId ?? await deps.findWorkspaceSessionId(scoped, indexed.chatId, deps);
        if (workspaceSessionId) {
          if (!indexed.workspaceSessionId) deps.updateEntry(projectId, { workspaceSessionId });
          state = await deps.ccrRequest(scoped, `/v1/code/sessions/${encodeURIComponent(workspaceSessionId)}`);
        }
      } catch { /* Session discovery is optional; retain the message-based fallback on any failure. */ }
      const turn = classifyChatTurn({ messages, signature, session: state, submitSignature: indexed.lastSubmitSignature, now: deps.now(), sessionStallMs: deps.stallMs, ...(deps.chatStallMs === undefined ? {} : { stallMs: deps.chatStallMs }) });
      return {
        projectId, backend: 'artifacts', ...turn,
        files: manifest.files.filter(({ path }) => path.startsWith('project/'))
          .map(({ path, size, sha256 }) => ({ path: path.slice('project/'.length), size, sha256 })),
        answeredQuestions: false, checkPath: 'artifacts', signature,
        remoteUpdatedAt: new Date(manifest.updatedAt).toISOString(),
      };
    }
    const sessionId = await deps.resolveSessionId(scoped, projectId);
    if (!sessionId) throw new Error(`no Cowork session found for artifact ${projectId}`);
    const [state, manifest] = await Promise.all([
      deps.ccrRequest(scoped, `/v1/code/sessions/${encodeURIComponent(sessionId)}`),
      deps.readManifest(scoped, projectId),
    ]);
    const idle = state.worker_status === 'idle' && FINISHED_BUCKETS.has(state.status_bucket);
    const events = (state.requires_action_details_list?.length || !idle)
      ? [] : await deps.readTurnEvents(scoped, sessionId, { ccrRequest: deps.ccrRequest });
    const signature = await deps.signature(manifest.files);
    const entry = deps.readIndex().byArtifact[projectId];
    const turn = classifyArtifactTurn({
      session: state, events, signature, submitSignature: entry?.lastSubmitSignature,
      now: deps.now(), stallMs: deps.stallMs,
    });
    return {
      projectId, sessionId, backend: 'artifacts', ...turn,
      files: manifest.files.filter(({ path }) => path.startsWith('project/'))
        .map(({ path, size, sha256 }) => ({ path: path.slice('project/'.length), size, sha256 })),
      answeredQuestions: false, checkPath: 'artifacts', signature,
      remoteUpdatedAt: new Date(manifest.updatedAt).toISOString(),
    };
  });
}
