# @pertexo/observability

Follow the [root rules](../../AGENTS.md); this file only adds to them.

## Purpose and boundary

Logs, traces and metrics for every process, and the safe description of a
process failure. Two entries, both Node only: `/startup` loads first in a
process (config, the OpenTelemetry SDK, process-failure description,
startup-setting refusals) and must not load pino, pg, HTTP or the app;
`/server` carries the rest (the structured logger, Nest registration,
shutdown, transport metrics, queue tracing). The API, the worker and ops use
it.

It depends on no workspace package, so other packages describe their own
failures only through the narrow contracts below. It never logs a raw error
message or a value a schema rejected.

## Layout

- `src/startup.ts`, `src/server.ts`: the entries.
- `src/config.ts`: the `OTEL_*` and logging environment, read once.
- `logging/`: the structured logger and credential redaction.
- `telemetry/`: the SDK runtime, span sanitisation, measurement, queue
  tracing and transport metrics.
- `lifecycle/`: shutdown, Nest registration, the stop-aware wait and the
  database client settings every process shares.
- `process-failure/`: the process-failure description, the startup-setting
  refusal and the description of the database's inherited-settings refusal.

## Where new code goes

- A new metric: its instrument in `telemetry/` and its name in the
  operations assets (`test/operations-assets.test.ts` checks both).
- A new startup refusal: a reason and its repair text in
  `process-failure/startup-setting.errors.ts`, thrown by the app's config.
- A new failure another package owns: describe it in `process-failure/` from
  checked fields only, and test it from the app that sees both packages.

## Defaults and config

- Environment: `config.ts`; shared database client defaults:
  `lifecycle/database-config.ts`.
- Text and depth bounds: constants at the top of each `logging/` and
  `process-failure/` file.

## Rules

- `/startup` stays free of pino, pg, HTTP and the application.
- Error text is private: descriptions are built from closed vocabularies
  (system error codes, setting repairs) and fields checked to be plain tokens
  (the inherited-settings role and setting names), and everything else is
  `[Redacted]`.

## Exceptions

- `process-failure/inherited-session-context.ts` reads the database's
  refusal by its name and two fields, because observability loads before the
  database and can't import it. The API's
  `inherited-session-context-failure.test.ts` describes a real refusal for
  every pool role and app setting.

## What guards it

- `pnpm --filter @pertexo/observability test`: logging privacy, sanitisation,
  failure description, metrics and the operations assets.
- `pnpm observability:check` qualifies the collector and Prometheus configs
  (Docker).
- `pnpm check`: package structure, naming, environment and backend-limits
  checks.
