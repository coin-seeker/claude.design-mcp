import { decodeProjectData, fileEntriesOf, generatedFileEntries, lastMessageOf } from './helpers.mjs';
import { omelette } from './rpc.mjs';
import { classifyPollStatus } from './check.mjs';
import { stabilitySignature } from './turn-classify.mjs';

const QUESTION_TOOLS = new Set(['ask_user', 'questions_v2']);
export const NORMAL_TURN_ENDS = new Set();

export function isAbnormalTurnEnd(turnEnd) {
  return Boolean(turnEnd) && !NORMAL_TURN_ENDS.has(turnEnd);
}

export function rpcNeedsUi(data) {
  const last = lastMessageOf(data);
  if (last?.role !== 'assistant') return false;
  return last.kind === 'question-record'
    || last.contentBlocks?.some((block) => block.type === 'tool_call' && QUESTION_TOOLS.has(block.toolCall?.name)) === true
    || isAbnormalTurnEnd(last.turnEnd)
    || last.contentBlocks?.at(-1)?.type === 'error';
}

export async function checkDesignRpc(scoped, projectId, deps = {}) {
  const call = deps.callOmelette || omelette;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const data = decodeProjectData(await call(scoped.page, 'GetProjectData', { projectId }, scoped.org));
  if (rpcNeedsUi(data)) return { fallback: 'needs-ui' };
  const history = [];
  let files = [];
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await sleep(2_000);
    files = generatedFileEntries(fileEntriesOf(await call(scoped.page, 'ListFiles', { projectId, depth: 100, offset: 0 }, scoped.org)));
    history.push(stabilitySignature(files));
  }
  const lastMessageRole = lastMessageOf(data)?.role ?? null;
  const status = classifyPollStatus({ history, files, lastMessageRole, isHeld: false });
  if (status === 'no_output') return { fallback: 'no-output' };
  return { projectId, status, files, lastMessageRole, answeredQuestions: false, checkPath: 'rpc' };
}
