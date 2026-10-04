import { tryAnswerQuestions } from './turn.mjs';
import { stabilitySignature, signatureStable } from './turn-classify.mjs';
import { omelette } from './rpc.mjs';
import { fileEntriesOf, generatedFileEntries, lastMessageRoleOf } from './helpers.mjs';
import { isDomTransitionError, isPageError } from './errors.mjs';
import { awaitDesignReady, holdOperationPage, isHeldOperationPage } from './session.mjs';
import { logEvent } from './log.mjs';
import { observeTurnAction } from './turn-network.mjs';
import { monitorPendingTurn } from './pending-monitor.mjs';
import { applyEffortToPage, projectEffort } from './model.mjs';

const POLL_INTERVAL_MS = 2_000;
const POLL_CYCLES = 3;
const MAX_RESUME_ATTEMPTS = 3;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const resumeAttempts = new Map();
export function classifyPollStatus({ history, files, lastMessageRole, isHeld, cycles = POLL_CYCLES }) {
  const stable = signatureStable(history, cycles);
  return !stable ? 'generating'
    : files.length === 0 ? lastMessageRole === 'user' ? isHeld ? 'generating' : 'stalled' : 'no_output'
      : lastMessageRole === 'assistant' ? 'done' : 'generating';
}
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

function claimResume(projectId) {
  const key = String(projectId);
  const attempts = resumeAttempts.get(key) || 0;
  if (attempts >= MAX_RESUME_ATTEMPTS) {
    return { allowed: false, attempts, maxAttempts: MAX_RESUME_ATTEMPTS };
  }
  const next = attempts + 1;
  resumeAttempts.set(key, next);
  return { allowed: true, attempts: next, maxAttempts: MAX_RESUME_ATTEMPTS };
}

export async function checkDesign(session, projectId, deps = {}) {
  const effort = projectEffort(projectId);
  const applyEffort = deps.applyEffort || applyEffortToPage;
  const answerQuestions = deps.answerQuestions || ((page) => tryAnswerQuestions(page, { effort, applyEffort }));
  const ready = deps.awaitReady || awaitDesignReady;
  const inspectInterruption = deps.interruptionState || interruptionState;
  const monitorPending = deps.monitorPending || monitorPendingTurn;
  const holdPage = deps.holdPage || holdOperationPage;
  const isHeldPage = deps.isHeldPage || isHeldOperationPage;
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
    const resume = claimResume(projectId);
    if (!resume.allowed) {
      const lastMessageRole = await getLastMessageRole();
      logEvent('turn.resume_exhausted', { projectId, resumeAttempts: resume.attempts, maxResumeAttempts: resume.maxAttempts });
      return {
        projectId,
        status: 'resume_exhausted',
        files: baselineFiles,
        lastMessageRole,
        answeredQuestions: false,
        interrupted: true,
        resumed: false,
        resumeAttempts: resume.attempts,
        maxResumeAttempts: resume.maxAttempts,
        problem: 'resume_attempts_exhausted',
      };
    }
    // Resume restarts generation from the composer's effort, which this page load reset to Medium.
    await applyEffort(session.page, effort, { required: true });
    await observeTurnAction(session.page, async () => {
      logEvent('turn.resume_click', { projectId, resumeAttempts: resume.attempts, url: typeof session.page.url === 'function' ? session.page.url() : '' });
      await interruption.resumeButton.click({ timeout: 15_000 });
    }, {
      kinds: ['chat', 'renew'],
      postOnly: false,
      requireResponse: false,
      timeoutMs: Number(deps.turnStartTimeoutMs ?? 15_000),
      requestTimeoutMessage: 'Resume follow-up Chat or RenewTurn was not observed',
    });
    if (!isHeldPage(session.page)) {
      const completion = monitorPending(session, projectId, {
        answerQuestions,
        baselineSignature: stabilitySignature(baselineFiles),
        listFiles: async () => listFiles(),
        getLastMessageRole: async () => getLastMessageRole(),
        requireChange: false,
      });
      holdPage(session.page, completion, 'resumed-turn-finished', { projectId });
    }
    const [files, lastMessageRole] = await Promise.all([listFiles(), getLastMessageRole()]);
    return {
      projectId,
      status: 'generating',
      files,
      lastMessageRole,
      answeredQuestions: false,
      interrupted: true,
      resumed: true,
      resumeAttempts: resume.attempts,
      maxResumeAttempts: resume.maxAttempts,
    };
  }

  resumeAttempts.delete(String(projectId));

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
    if (answeredQuestions && !isHeldPage(session.page)) {
      const completion = monitorPending(session, projectId, {
        answerQuestions,
        baselineSignature: stabilitySignature(baselineFiles),
        listFiles: async () => listFiles(),
        getLastMessageRole: async () => getLastMessageRole(),
        requireChange: false,
      });
      holdPage(session.page, completion, 'continued-turn-finished', { projectId });
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
  const status = classifyPollStatus({ history, files, lastMessageRole, isHeld: isHeldPage(session.page) });

  return { projectId, status, files, lastMessageRole, answeredQuestions: false };
}
