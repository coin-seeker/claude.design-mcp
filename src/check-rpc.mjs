import { lastMessageOf } from './helpers.mjs';

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
