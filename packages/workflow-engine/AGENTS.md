# @pertexo/workflow-engine

Follow the [root rules](../../AGENTS.md); this file only adds to them.

## Purpose and boundary

The pure workflow engine: it compiles a graph into an executable, and from a
checkpoint plus what happened (observations) it decides the next transition
plan: what to admit, retry, wait for, settle, route on failure or finish. It
also runs one step attempt through the node registry, plans recovery and
compiles draft tests. `core` persists what it decides; the worker and API
call it through `core`.

Two entries. `@pertexo/workflow-engine` is safe in the browser: the
execution vocabulary and limits. `@pertexo/workflow-engine/server` is Node
only: compilation, `advanceWorkflow`, `executeNodeAttempt`, checkpoints and
recovery. It depends on `@pertexo/workflow-model` and `@pertexo/node-sdk`
alone. It never does I/O, never reads the environment or the clock (callers
pass `occurredAt`) and never stores anything: every input arrives as data and
every decision leaves as a plan.

## Layout

- `src/index.ts`, `src/server.ts`: the entries.
- `src/workflow-execution.ts`: the engine's state vocabulary (statuses,
  observations, checkpoint, transition plan, intents) every area reads.
- `src/workflow-engine.errors.ts`: `WorkflowEngineError` and its codes.
- `compilation/`: graph to executable, its validation, digests and capacity.
- `checkpoint/`: creating, parsing and admitting checkpoints.
- `observation/`: parsing persisted observations and the coordinator's
  calls, tasks, loops, outputs and failures.
- `transition/`: `advanceWorkflow` (`advance-workflow.ts`), the advance
  itself, decisions, loops, stops, pruning and `scheduling/`.
- `attempt/`: one step attempt: admission, input mapping and its refusals,
  retries and provider keys.
- `invocations/`: invocation keys, branch and iteration scope, output
  references.
- `control-nodes/`: control output ports, core control identities and join
  settlement.
- `failure-routing/`, `completion/`, `recovery/`, `testing/`: failure routes,
  run completion (error workflows, failure notifications), recovery plans
  and draft-test compilation.
- `input-checks/`: the exact-field rule and value checks every boundary
  uses.

## Where new code goes

- A new observation: its type in `workflow-execution.ts`, its parser in
  `observation/persisted-parser.ts`, and its effect in `transition/`.
- A new decision: a pure function in the area that owns it, called from
  `transition/advance.ts`; it returns a plan, never performs it.
- A new refusal: a `WorkflowEngineError` code, or a family in that area's
  `.errors.ts` (`attempt/mapping-refusal.errors.ts`,
  `compilation/executable.errors.ts`).

## Defaults and config

- No environment. Limits: `NODE_ATTEMPT_INPUT_LIMITS`
  (`workflow-execution.ts`), `WORKFLOW_CHECKPOINT_LIMITS`
  (`checkpoint/admission.ts`), `COORDINATOR_COMPLETION_WINDOW_LIMITS`
  (`observation/coordinator-output.ts`), with graph bounds read from
  `WORKFLOW_GRAPH_CONTRACT_LIMITS` and stored-integer ceilings from
  `STORED_INTEGER_MAX` (both `workflow-model`).

## Rules

- `checkpoint/` never imports `transition/`; shared pieces live in
  `invocations/` or `control-nodes/` (a module-import check enforces it).
- Untrusted input becomes a coded `WorkflowEngineError`, never a raw throw:
  executables through `readUntrusted` (`compilation/executable.errors.ts`),
  observations through `observation/persisted-parser.ts`, and both with the
  `input-checks/` rules.

## Exceptions

- `compilation/` holds eighteen direct files: each is one step of turning a
  graph into a verified executable, and the steps share private shapes.
- Generic throws that stay are assertions in `attempt/retries.ts`: an
  unsupported retry policy kind and an empty provider identity, both ruled
  out by the callers' types.

## What guards it

- `pnpm --filter @pertexo/workflow-engine test`: compilation, checkpoints,
  observations, transitions and scheduling, attempts, recovery, failure
  routing and draft tests, with property tests over serialized boundaries.
- `pnpm check`: package structure, naming, browser-entry, module-import,
  environment and backend-limits checks.
