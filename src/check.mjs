import { tryAnswerQuestions } from './turn.mjs';
import { stabilitySignature, signatureStable } from './turn-classify.mjs';
import { omelette } from './rpc.mjs';
import { fileEntriesOf, generatedFileEntries } from './helpers.mjs';
import { isDomTransitionError, isPageError } from './errors.mjs';
import { awaitDesignReady, holdOperationPage } from './session.mjs';
import { logEvent } from './log.mjs';
import { observeTurnAction } from './turn-network.mjs';
import { monitorPendingTurn } from './pending-monitor.mjs';

const POLL_INTERVAL_MS = 2_000;
const POLL_CYCLES = 3;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function questionFormVisible(page) {
  const continueButton = page.locator('button:has-text("Continue")').first();
  return (await continueButton.count()) > 0 && await continueButton.isVisible();
}

async function interruptionState(page) {
  const banner = page.locator('[data-testid="chat-messages"]').filter({ hasText: /We got interrupted — the work paused before finishing\./i }).first();
  const interrupted = (await banner.count()) > 0 && await banner.isVisible();
  if (!interrupted) return { interrupted: false, resumeButton: null };
  const resumeButton = page.locator('[data-testid="chat-messages"] button').filter({ hasText: /Resume/i }).first();
  const canResume = (await resumeButton.count()) > 0 && await resumeButton.isVisible();
  return { interrupted: true, resumeButton: canResume ? resumeButton : null };
}

function lastMessageRoleOf(raw) {
  const data = raw?.data
    ? JSON.parse(Buffer.from(String(raw.data), 'base64').toString('utf8'))
    : raw;
  const chats = Object.values(data?.chats || {});
  const messages = chats.flatMap((chat) => Array.isArray(chat.messages) ? chat.messages : []);
  const role = messages.at(-1)?.role;
  return role === 'assistant' || role === 'user' ? role : null;
}

export async function checkDesign(session, projectId, deps = {}) {
  const answerQuestions = deps.answerQuestions || tryAnswerQuestions;
  const ready = deps.awaitReady || awaitDesignReady;
  const inspectInterruption = deps.interruptionState || interruptionState;
  const monitorPending = deps.monitorPending || monitorPendingTurn;
  const holdPage = deps.holdPage || holdOperationPage;
  const isQuestionFormVisible = deps.questionFormVisible || questionFormVisible;
  const callOmelette = deps.callOmelette || omelette;
  const sleep = deps.sleep || delay;
  const pollIntervalMs = Number(deps.pollIntervalMs ?? POLL_INTERVAL_MS);
  await ready(session.page, projectId);
  const listFiles = async () => generatedFileEntries(fileEntriesOf(await callOmelette(
    session.page,
    'ListFiles',
    { projectId, depth: 100, offset: 0 },
    session.org,
  )));
  const getLastMessageRole = async () => lastMessageRoleOf(await callOmelette(
    session.page,
    'GetProjectData',
    { projectId },
    session.org,
  ));

  let interruption;
  try {
    interruption = await inspectInterruption(session.page);
  } catch (error) {
    if (!isDomTransitionError(error)) throw error;
    interruption = { interrupted: false, resumeButton: null };
  }
  if (interruption.interrupted) {
    if (!interruption.resumeButton) {
      const [files, lastMessageRole] = await Promise.all([listFiles(), getLastMessageRole()]);
      return { projectId, status: 'interrupted', files, lastMessageRole, answeredQuestions: false, interrupted: true };
    }
    const baselineFiles = await listFiles();
    await observeTurnAction(session.page, async () => {
      logEvent('turn.resume_click', { projectId, url: typeof session.page.url === 'function' ? session.page.url() : '' });
      await interruption.resumeButton.click({ timeout: 15_000 });
    }, {
      kinds: ['chat', 'renew'],
      postOnly: false,
      requireResponse: false,
      timeoutMs: Number(deps.turnStartTimeoutMs ?? 15_000),
      requestTimeoutMessage: 'Resume follow-up Chat or RenewTurn was not observed',
    });
    const completion = monitorPending(session, projectId, {
      answerQuestions,
      baselineSignature: stabilitySignature(baselineFiles),
      listFiles: async () => listFiles(),
      requireChange: false,
    });
    holdPage(session.page, completion, 'resumed-turn-finished');
    const [files, lastMessageRole] = await Promise.all([listFiles(), getLastMessageRole()]);
    return { projectId, status: 'generating', files, lastMessageRole, answeredQuestions: false, interrupted: true, resumed: true };
  }

  let hasQuestionForm = false;
  try {
    hasQuestionForm = await isQuestionFormVisible(session.page);
  } catch (error) {
    if (!isDomTransitionError(error)) throw error;
    return {
      projectId,
      status: 'generating',
      files: [],
      lastMessageRole: null,
      answeredQuestions: false,
    };
  }

  if (hasQuestionForm) {
    const baselineFiles = await listFiles();
    let answeredQuestions = false;
    try {
      answeredQuestions = await answerQuestions(session.page);
    } catch (error) {
      if (isPageError(error)) throw error;
      const message = error?.message || '';
      if (!(error instanceof Error) || !message.match(/locator|selector|element|timeout|visible|count/i)) throw error;
    }
    const [files, lastMessageRole] = await Promise.all([listFiles(), getLastMessageRole()]);
    if (answeredQuestions) {
      const completion = monitorPending(session, projectId, {
        answerQuestions,
        baselineSignature: stabilitySignature(baselineFiles),
        listFiles: async () => listFiles(),
        requireChange: false,
      });
      holdPage(session.page, completion, 'continued-turn-finished');
    }
    return {
      projectId,
      status: answeredQuestions ? 'generating' : 'awaiting_input',
      files,
      lastMessageRole,
      answeredQuestions,
    };
  }

  const history = [];
  let files = [];
  for (let cycle = 0; cycle < POLL_CYCLES; cycle += 1) {
    await sleep(pollIntervalMs);
    files = await listFiles();
    history.push(stabilitySignature(files));
  }
  const lastMessageRole = await getLastMessageRole();
  const stable = signatureStable(history, POLL_CYCLES);
  const status = !stable
    ? 'generating'
    : files.length === 0
      ? lastMessageRole === 'user' ? 'stalled' : 'no_output'
      : lastMessageRole === 'assistant'
        ? 'done'
        : 'generating';

  return { projectId, status, files, lastMessageRole, answeredQuestions: false };
}
