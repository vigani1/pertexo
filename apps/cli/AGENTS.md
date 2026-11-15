# @pertexo/cli

Follow the [root rules](../../AGENTS.md); this file only adds to them.

## Purpose and boundary

The `pertexo` command: automation over the public HTTP API with a personal
API token. It parses a command, calls the documented routes and prints one
JSON line. It never touches the database or `core`; the API is its only
door. Secrets come only from the environment.

## Layout

- `src/main.ts`: the bin entry. `src/run-automation-cli.ts`: one run: parse,
  configure, execute, print, set the exit code.
- `config/`: `PERTEXO_API_URL` and `PERTEXO_API_TOKEN`, read and validated
  once (`automation-http-config.ts`).
- `commands/`: argument parsing, command execution, request-body files and
  `AutomationCommandError` with its exit codes.
- `http/`: the HTTP client over the API.

## Where new code goes

- A new command: its arguments in `commands/automation-arguments.ts`, its
  execution in `commands/execute-automation-command.ts`, its help line in
  `run-automation-cli.ts`.

## Defaults and config

- Only the two settings above, in `config/`.

## Rules

- Every failure the caller sees is an `AutomationCommandError` with a code
  and exit code; anything else becomes `cli.command_failed`.

## Exceptions

- None.

## What guards it

- `pnpm --filter @pertexo/cli test`: parsing, execution against a fake
  client, the HTTP client, and the process itself.
- `pnpm check`: package structure, naming and environment checks.
