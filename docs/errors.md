# Error codes

Generated from control-plane/src/errors/words.ts by `pnpm gen:errors`. Do not edit.

## DR101

Invalid input at {path}: {reason}.

### Fix

Fix the value at {path} and send the request again.

## DR103

Making {key} blocked by {blockedBy} would create a dependency cycle.

### Fix

Remove one of the existing dependencies between {key} and {blockedBy}, or drop this one.

## DR104

A reason is required to move a task from {from} to {to}.

### Fix

Send a non-empty reason with the request and try again.

## DR150

Protocol message {type} is invalid at {path}: {reason}.

### Fix

The executor and the control plane disagree on the message shape: update the older side so both run the same release.

## DR151

Executor protocol {got} is not supported; this control plane speaks {supported}.

### Fix

Update the older of the executor and the control plane so both speak protocol {supported}.

## DR201

No {kind} {key} found.

### Fix

Check the {kind} key with `devrounds plan show`; keys are case-sensitive.

## DR202

The control plane has no route {route}.

### Fix

Check the URL; if the CLI sent it, compare its version with `GET /api/health` and update the older one.

## DR301

A task cannot move from {from} to {to}.

### Fix

Check the allowed moves for the current state, then pick another target state.

## DR302

The task is blocked by open tasks: {blockers}.

### Fix

Finish or cancel {blockers}, or remove the blocker links, then start the task again.

## DR303

The task has {count} open acceptance criteria.

### Fix

Check off the {count} open criteria before marking the task done.

## DR304

Phases that must be delivered first are still open: {phases}.

### Fix

Deliver {phases} before starting tasks in this phase.

## DR305

The phase cannot close: {openTasks} open tasks, {openCriteria} open criteria, no done task: {noDoneTask}.

### Fix

Finish or cancel the open tasks, check off the criteria, and make sure at least one task is done.

## DR306

Phase {phase} is {state}, which does not allow this change.

### Fix

A delivered phase accepts no open work: reopen {phase} first with a reason. An open phase cannot be reopened, and a delivered one cannot be closed again.

## DR307

Task {task} is {state}, which does not allow this change.

### Fix

A done or cancelled task accepts no new open criteria: reopen {task} first with `devrounds task reopen {task} --reason <text>`.

## DR401

Missing or invalid API token.

### Fix

Send `Authorization: Bearer <token>` with a token from `devrounds-admin token create`; a revoked token no longer works.

## DR501

Internal error.

### Fix

Retry once; if it keeps failing, check the control plane log for the cause.

## DR502

Control plane configuration is invalid: {reason}.

### Fix

Fix ~/.devrounds/server.json or the DEVROUNDS_* environment variables, then start again.
