# @pertexo/code-runner

Follow the [root rules](../../AGENTS.md); this file only adds to them.

## Purpose and boundary

The Code step's sandbox manager: it listens on a private Unix socket, keeps
a pool of single-use task processes (JavaScript and Python) and returns
each task's result. The manager never evaluates user code; task processes
do, inside the container's fences. It depends on `@pertexo/node-sdk` for
the Code settings and limits.

## Layout

- `src/main.ts`: the process entry (the image runs its built file).
  `src/runner-application.ts`: checks isolation, starts the pool and the
  socket.
- `config/`: the runner's settings (`runner-config.ts`) and their errors.
- `isolation/`: the hardened-mode container checks the manager refuses to
  start without.
- `transport/`: the socket server and stale-socket handling.
- `process/`: the task-process pool, one slot per process, packages, logs
  and child diagnostics.
- `execution/`: what runs inside a task process (module policy, console,
  encoding).
- `native/`, `python/`: the launcher and the Python task host.

## Where new code goes

- A new container check: `isolation/assert-runner-isolation.ts`.
- A new task language: `process/slot.ts` and a task host beside
  `execution/`.

## Defaults and config

- Settings: `config/runner-config.ts`, parsed once; the Code limits come
  from node-sdk's `CODE_LIMITS` and the instance's Code settings.
- The hardened task PATH: `HARDENED_TASK_PATH` (`config/runner-config.ts`).

## Rules

- A task process serves one task and exits; a reservation is used once.
- Startup refuses to run outside the hardened container in a deployed
  environment.

## Exceptions

- None.

## What guards it

- `pnpm --filter @pertexo/code-runner test`: isolation checks against a
  fake host, and real JavaScript and Python task processes (the Python
  cases need `python3.15` on the PATH).
- `pnpm check`: package structure, naming and environment checks.
