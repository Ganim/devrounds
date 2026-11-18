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

A reason is required for this change.

### Fix

Send a non-empty reason with the request (the CLI takes --reason <text>) and try again.

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

## DR350

Machine {machine} is not connected.

### Fix

Start the executor on {machine} with `devrounds-executor run`, then check `devrounds machine list` shows it connected.

## DR351

Run {run} is {state}, which does not allow this change.

### Fix

Read the state of run {run} again with `devrounds run show {run}`: a finished, failed, stopped or orphaned run takes no more events and is the only kind that can be retried.

## DR352

Another executor is running for {home} (pid {pid}).

### Fix

Stop the executor with pid {pid}, or give this one another home with DEVROUNDS_EXECUTOR_HOME.

## DR401

Missing or invalid API token.

### Fix

Send `Authorization: Bearer <token>` with a token from `devrounds-admin token create`; a revoked token no longer works.

## DR450

Pairing code is invalid, expired or already used.

### Fix

Ask a human member for a new code (`devrounds machine pair-code --name <machine>`) and pair within 10 minutes.

## DR451

Pairing is locked for {minutes} minutes after repeated failures.

### Fix

Wait {minutes} minutes, then pair with a fresh code; check that the code is typed exactly as printed.

## DR452

Machine token is missing, invalid or revoked.

### Fix

Pair again with `devrounds-executor pair --url <url> --code <code>` and a new code from `devrounds machine pair-code`.

## DR453

Only a human member can {action}.

### Fix

Ask a human member to {action}, or run the command with a human member token.

## DR501

Internal error.

### Fix

Retry once; if it keeps failing, check the control plane log for the cause.

## DR502

Control plane configuration is invalid: {reason}.

### Fix

Fix the file named in the message (~/.devrounds/server.json for the server, ~/.devrounds/config.json for the CLI) or the DEVROUNDS_* environment variables, then run it again.

## DR503

Log segment {firstSeq}-{lastSeq} of run {run} cannot be read: {reason}.

### Fix

Read on past it with `devrounds run logs {run} --cursor {next}`; the lines in that segment are not readable.

## DR550

Executor state at {path} is unusable: {reason}.

### Fix

Make {path} usable only by the account running the executor (or move it away to start fresh), then try again.

## DR551

Executor configuration is invalid: {reason}.

### Fix

Fix the URL passed to `devrounds-executor pair` or config.json in the executor home, then start again.
