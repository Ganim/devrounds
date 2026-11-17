# Error codes

Generated from control-plane/src/errors/words.ts by `pnpm gen:errors`. Do not edit.

## DR101

Invalid input at {path}: {reason}.

### Fix

Fix the value at {path} and send the request again.

## DR501

Internal error.

### Fix

Retry once; if it keeps failing, check the control plane log for the cause.

## DR502

Control plane configuration is invalid: {reason}.

### Fix

Fix ~/.devrounds/server.json or the DEVROUNDS_* environment variables, then start again.
