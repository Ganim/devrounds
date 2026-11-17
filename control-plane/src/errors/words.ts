import type { ErrorCode } from './codes.ts'

export type Words = { text: string; hint: string; httpStatus: number; keys: string[] }

// Single home for error text, hint and HTTP status. `{name}` placeholders are filled from the error data.
export const WORDS: Record<ErrorCode, Words> = {
  DR101: {
    text: 'Invalid input at {path}: {reason}.',
    hint: 'Fix the value at {path} and send the request again.',
    httpStatus: 400,
    keys: ['path', 'reason'],
  },
  DR104: {
    text: 'A reason is required to move a task from {from} to {to}.',
    hint: 'Send a non-empty reason with the request and try again.',
    httpStatus: 400,
    keys: ['from', 'to'],
  },
  DR301: {
    text: 'A task cannot move from {from} to {to}.',
    hint: 'Check the allowed moves for the current state, then pick another target state.',
    httpStatus: 409,
    keys: ['from', 'to'],
  },
  DR302: {
    text: 'The task is blocked by open tasks: {blockers}.',
    hint: 'Finish or cancel {blockers}, or remove the blocker links, then start the task again.',
    httpStatus: 409,
    keys: ['blockers'],
  },
  DR303: {
    text: 'The task has {count} open acceptance criteria.',
    hint: 'Check off the {count} open criteria before marking the task done.',
    httpStatus: 409,
    keys: ['count'],
  },
  DR304: {
    text: 'Phases that must be delivered first are still open: {phases}.',
    hint: 'Deliver {phases} before starting tasks in this phase.',
    httpStatus: 409,
    keys: ['phases'],
  },
  DR305: {
    text: 'The phase cannot close: {openTasks} open tasks, {openCriteria} open criteria, no done task: {noDoneTask}.',
    hint: 'Finish or cancel the open tasks, check off the criteria, and make sure at least one task is done.',
    httpStatus: 409,
    keys: ['openTasks', 'openCriteria', 'noDoneTask'],
  },
  DR501: {
    text: 'Internal error.',
    hint: 'Retry once; if it keeps failing, check the control plane log for the cause.',
    httpStatus: 500,
    keys: [],
  },
  DR502: {
    text: 'Control plane configuration is invalid: {reason}.',
    hint: 'Fix ~/.devrounds/server.json or the DEVROUNDS_* environment variables, then start again.',
    httpStatus: 500,
    keys: ['reason'],
  },
}
