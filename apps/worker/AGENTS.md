# @pertexo/worker

Follow the [root rules](../../AGENTS.md); this file only adds to them.

## Purpose and boundary

The background process: it consumes queue deliveries (runs, node attempts,
triggers, previews, notifications, mail, maintenance), publishes the outbox
and runs the periodic scans (stalled work, retention, auto-pause, inbox).
Every decision is `core`'s or `workflow-engine`'s; the worker wires live
resources to them, bounds their time and reports health. It reads the
environment only in `config/`.

## Layout

- `src/main.ts`: the process entry. `src/testing.ts`: the test entry.
  `src/worker-application.ts`: starts and stops the application (the
  production-image check loads its built file). `src/worker.module.ts`: the Nest composition root.
- `config/`: the worker's settings (`worker.ts`, mail and invitation
  delivery settings) and their errors.
- `transport/`: queue consumption, the outbox dispatcher and job wiring.
- `attempts/`: node attempts: delivery, execution and its capabilities,
  artifacts and scratch space, Code and callbacks.
- `runs/`, `triggers/`, `previews/`, `notifications/`, `mail/`,
  `connections/`, `providers/`, `workflows/`, `retention/`, `maintenance/`,
  `operator/`: one area per kind of work.
- `runtime/`: process lifetime: polling and scanning loops, startup
  verification, readiness, shutdown and keepalive.
- `platform/`: database and observability modules.

## Where new code goes

- A new queue job's handler: in its area, wired in `worker.module.ts` and
  `transport/`.
- A periodic job: a polling runtime (`runtime/polling.ts`) in its area as
  `<subject>.runtime.ts`.
- A live resource: `<subject>.runtime.ts`, opened and closed by its runtime.
- An error: its class in the subject's `.errors.ts`.

## Defaults and config

- Settings: `config/worker.ts`, parsed once at startup and passed inward.
  `config/worker.ts` and `mail/system-mail-client.ts` are host-mounted
  internals (`MOUNTED_INTERNALS`); keep their built paths.
- Numeric settings' bounds and defaults: `WORKER_SETTING_BOUNDS`
  (`config/worker-environment.schemas.ts`); mail send and poll bounds:
  `MAIL_SETTING_BOUNDS` (`config/mail-settings.ts`); runtime shutdown and
  startup-check timeouts: `runtime/background-task-deadline.ts`. Every
  other limit sits beside what it bounds, and the limits check covers the
  app.
- Queue attempts, backoff and concurrency come from `@pertexo/queue`'s
  `QUEUE_CLASS_DEFAULTS`; step retries from `workflow-engine`.

## Rules

- Readiness reports a named error (`runtime/runtime-readiness.errors.ts`)
  until a loop has completed a cycle against its store.

## Exceptions

- Generic throws that stay are assertions: a preview supervisor asked to own
  a second invocation (`previews/supervisor.ts`), an unknown failure
  destination (`notifications/failure-delivery.ts`), and a scanner runtime
  used after it closed (`runtime/scanner.ts`).
- Wrapping a rejection value that isn't an `Error`, so a cause is kept:
  `attempts/artifacts/node-artifact.runtime.ts`,
  `attempts/artifacts/scratch/consume.ts` (cleanup and operation) and
  `attempts/delivery/complete.ts` (a heartbeat failure).
- Abort reasons, which say why a signal fired and reach no caller as a
  domain error: readiness shutdown (`runtime/health/readiness-monitor.ts`),
  a stopped preview heartbeat (`previews/supervisor.ts`) and a
  failure-notification timeout (`notifications/failure-handler.ts`).

## What guards it

- `pnpm --filter @pertexo/worker test`: handlers, runtimes and composition
  against fakes.
- `pnpm --filter @pertexo/worker test:integration` needs PostgreSQL and
  Redis: real deliveries through core.
- `pnpm check`: package structure, naming, environment and dist-reference
  checks.
