# @pertexo/workflow-model

Follow the [root rules](../../AGENTS.md); this file only adds to them.

## Purpose and boundary

The shared domain vocabulary every layer agrees on: the workflow graph and
its validation, control steps, triggers, values and expressions, execution
lifecycle words, and the limits each of them carries. The browser, the API,
the worker, `core`, `contracts` and `workflow-engine` read it.

Two entries. `@pertexo/workflow-model` is safe in the browser: schemas,
types, limits and pure decisions. `@pertexo/workflow-model/server` is Node
only: authoring validation in worker threads, expression evaluation in child
processes, and graph fingerprints that use `node:crypto`. Consumers import
only these entries.

It never does I/O beyond those sandboxes, never reads the environment and
never owns identity, invitation, provider or delivery policy (those live in
`core`). It depends on `@pertexo/policy` (roles), `@pertexo/node-sdk` (JSON
encoding), `jsonata` and `zod`.

## Layout

- `src/index.ts`, `src/server.ts`: the entries, grouped by the area each
  export comes from.
- `graph/`: the graph schema and its limits, admission and validation
  (`validation/`), canvas notes, definition catalogs and fingerprints.
- `flow/`: control steps (`control-nodes/`), workflow calls (`callable/`),
  callbacks, failure routes and pending tasks.
- `execution/`: run and step lifecycle, retry settings, failures, recovery,
  retention and notice schedules.
- `triggers/`: schedules, webhooks, forms, event coordination and error
  workflows.
- `values/`: JSON (`json/`), text, expressions (`expressions/`, including
  the evaluator's child process), mappings and workspace variables.
- `authoring/`: connection bindings, portability, samples, test suites,
  publication review and the threaded authoring validator (`validation/`).
- `identity/`, `notifications/`, `workspaces/`: identity primitives, the
  failure-notification vocabulary, and workspace authoring limits and
  governance.

## Where new code goes

- A new step kind's config: a schema in the area that owns the step
  (`flow/control-nodes/`, `triggers/`), exported from `index.ts` under that
  area's heading.
- A new graph rule: `graph/validation/`, returning issues, never throwing for
  author mistakes.
- Anything that needs Node (threads, processes, `node:crypto`): its area,
  exported only from `server.ts`.
- A shared bound: a named constant in the owning file, beside the schema
  that enforces it; messages that state it are built from it.

## Defaults and config

- No environment. Limits live with their concept: `WORKFLOW_GRAPH_CONTRACT_LIMITS`
  (`graph/workflow-graph.schemas.ts`), `FORM_LIMITS` and `FORM_FILE_LIMITS`
  (`triggers/forms/`), `PENDING_TASK_LIMITS` (`flow/pending-tasks/audience.ts`),
  `EVENT_COORDINATION_LIMITS`, `STEP_RETRY_LIMITS`, `WORKFLOW_TEST_LIMITS`,
  `WORKFLOW_PORTABILITY_LIMITS`, `EXPRESSION_POLICY` and
  `AUTHORING_VALIDATION_BUDGET`.
- `STORED_INTEGER_MAX` (`values/stored-integer.ts`) is the one ceiling for
  values stored in PostgreSQL `integer` columns.

## Rules

- Everything in `index.ts` stays browser-safe; `pnpm check`'s browser-entry
  check refuses Node imports reaching it.
- Untrusted expressions run only through `JsonataEvaluator`, in a child
  process with `EXPRESSION_POLICY`'s limits; authoring validation runs only
  in `WorkflowAuthoringValidator`'s threads.
- Sizes a jsonb column will hold are measured the way PostgreSQL stores them
  (`storedTaskBytes` for pending tasks).

## Exceptions

- `graph/` holds thirteen direct files: each is one graph concept read across
  the package (aggregate bounds, catalogs, placement, fingerprints), and
  splitting them would add navigation without separating a responsibility.

## What guards it

- `pnpm --filter @pertexo/workflow-model test`: schemas and limits, graph
  validation, expression sandbox survival and fuzzing, forms, portability
  and the authoring validator.
- `pnpm check`: package structure, naming, browser-entry, environment and
  backend-limits checks.
