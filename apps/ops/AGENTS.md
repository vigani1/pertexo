# @pertexo/ops

Follow the [root rules](../../AGENTS.md); this file only adds to them.

## Purpose and boundary

Operator commands an administrator runs on the server: one command per
process, settings from the environment, a JSON result. The commands call
`core`; they hold no rules of their own.

## Layout

- `src/main.ts`: the operator entry. `src/execute-operator-command.ts`:
  runs one command and its cleanup (the production-image check loads its
  built file). `src/operator-config.ts`: the operator settings.
- `identity/`: the two-factor recovery command, with its own entry and
  settings.

## Where new code goes

- A new operator command: its settings in `operator-config.ts`, its case in
  `execute-operator-command.ts`, calling a `core` flow.

## Defaults and config

- Settings: `operator-config.ts` and `identity/two-factor-recovery-config.ts`.

## Rules

- A command that fails, or whose cleanup fails, reports every error in one
  `AggregateError`.

## Exceptions

- `execute-operator-command.ts`: a command that completes without a result
  is an assertion, so it stays a generic `Error`; so does a cleanup that
  outlives its timeout, which is gathered with the command's own failure
  into one `AggregateError`.
- `main.ts`: the interrupt that stops a command is an abort reason, not an
  error a caller handles.

## What guards it

- `pnpm --filter @pertexo/ops test`: settings and command execution.
- `pnpm check`: package structure, naming and environment checks.
