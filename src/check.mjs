import { tryAnswerQuestions } from './turn.mjs';
import { stabilitySignature, signatureStable } from './turn-classify.mjs';
import { omelette } from './rpc.mjs';
import { fileEntriesOf } from './helpers.mjs';

const POLL_INTERVAL_MS = 2_000;
const POLL_CYCLES = 3;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isSessionError = (error) => /closed|disconnected|Target/.test(String(error?.message || error));
async function questionFormVisible(page) {
  const continueButton = page.locator('button:has-text("Continue")').first();
  return (await continueButton.count()) > 0 && await continueButton.isVisible();
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
  const isQuestionFormVisible = deps.questionFormVisible || questionFormVisible;
  const callOmelette = deps.callOmelette || omelette;
  const sleep = deps.sleep || delay;
  const pollIntervalMs = Number(deps.pollIntervalMs ?? POLL_INTERVAL_MS);
  const listFiles = async () => fileEntriesOf(await callOmelette(
    session.page,
    'ListFiles',
    { projectId, depth: 100, offset: 0 },
    session.org,
  ));
  const getLastMessageRole = async () => lastMessageRoleOf(await callOmelette(
    session.page,
    'GetProjectData',
    { projectId },
    session.org,
  ));

  let hasQuestionForm = false;
  try {
    hasQuestionForm = await isQuestionFormVisible(session.page);
  } catch (error) {
    if (isSessionError(error)) throw error;
  }

  if (hasQuestionForm) {
    let answeredQuestions = false;
    try {
      answeredQuestions = await answerQuestions(session.page);
    } catch (error) {
      if (isSessionError(error)) throw error;
    }
    const [files, lastMessageRole] = await Promise.all([listFiles(), getLastMessageRole()]);
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
      ? 'no_output'
      : lastMessageRole === 'assistant'
        ? 'done'
        : 'generating';

  return { projectId, status, files, lastMessageRole, answeredQuestions: false };
}
