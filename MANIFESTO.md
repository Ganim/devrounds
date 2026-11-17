# DevRounds manifesto

Written before the first line of code, so what gets built does not drift. `AGENTS.md` derives enforceable invariants
from it. Per component, the manifest files (spec §5.6) carry the contract; there is no prose manifesto per component.

## 1. Everything is a task

Every effect is traceable to a task and a tenant. If something changed and nobody can say which task asked for it, the
audit trail is broken and so is the plan history (§5.8).

## 2. Engines own behaviour, providers only translate

An engine owns state, retries, limits, templating and audit for a capability; a provider adapts one external system to
the engine contract. Adding WhatsApp next to Slack must be one provider module, with no change to engine code
(§5.6). Capability differences are declared as named capabilities, never as `if provider === 'x'`.

## 3. Tenant-scoped by construction

There is no data access path without a tenant. Isolation is enforced by the database (row level security, composite
foreign keys), not by remembering to add a filter (§6). A cross-tenant lookup looks exactly like a missing row.

## 4. The core knows no customer, tool or vendor

Clickmax, pnpm, Linear, Claude and Slack are providers or job types. The moment the core names one of them, a second
customer needs a fork (§5.6, §5.7).

## 5. Declarative over imperative

Manifests, job types, flows and readiness are data, validated against schemas generated from code. Data can be listed,
diffed, validated and shown to agents; imperative setup code cannot (§5.6).

## 6. Delay, never kill; never freeze AI runs; never restart silently

Resource pressure delays new work instead of killing running work. An AI run that is paid for and in progress is not
frozen. Restarts are visible decisions made by the control plane, not side effects (§7).

## 7. No blocking work on an event loop

No synchronous child process or `*Sync` fs calls in request paths. One blocked call stalls every tenant sharing the
loop. In Rust the equivalent is `spawn_blocking` (§7).

## 8. Errors are codes with data

An error is a `DevRoundsError{code, data}`. Text, hint and HTTP status live in one words layer, and every code is
documented. Codes are never renumbered, so agents and scripts can depend on them (§5.8, agent surface).

## 9. Protocols evolve by features, not by breaking

Peers exchange `Hello` with named features; unknown messages are ignored. Old executors keep working while the control
plane moves forward (§5.7: the executor is one binary on every machine).

## 10. Tests prove contracts and consistency

Prefer meta-tests (generated references are current, every documented command parses, every error code has text) over
trivial behaviour tests. A flaky test is fixed, never rerun (§15).

## 11. Simple and explicit over clever

Explicit registration, explicit wiring, one way to do each thing. A reader should find where something happens by
searching for it (§5.6: no auto-discovery magic).

## How this document changes

Only together with `AGENTS.md`, and only with Guilherme's approval (§15: he approves rule changes).
