# @pertexo/nodes-core

Follow the [root rules](../../AGENTS.md); this file only adds to them.

## Purpose and boundary

The built-in steps: triggers, flow control and data steps, each a
definition, an executor and its schemas on the `node-sdk` contract, and the
core catalog that lists them. `node-catalog` merges it with `integrations`
into the platform catalog; the worker runs the executors.

Two entries. `@pertexo/nodes-core` is safe in the browser: definitions,
schemas and the catalog. `@pertexo/nodes-core/server` adds the executor
registrations. It depends on `@pertexo/node-sdk` and `@pertexo/workflow-model`.
It never talks to a provider or the network (that is `integrations`), never
reads the environment and never reaches the database: executors use only the
runtimes their invocation carries.

## Layout

- `src/index.ts`, `src/server.ts`: the entries.
- `catalog/`: the core catalog (`core-node-catalog.ts`), the definition and
  executor registration lists, and the policy identities steps declare.
- `triggers/`: manual, schedule, webhook, form and workflow-error triggers.
- `flow/`: condition, switch, parallel, merge, for-each, call, wait,
  approval, request-input, respond-webhook and terminate.
- `data/`: set, code, date, validate, run-values, create-file, read-file,
  lists (`lists/<step>/` plus their pure `lists/semantics/`), data tables
  (`tables/`) and utilities (`utilities/<operation>/`).

Each step is `<area>/<step>/<step>.definition.ts`, `.executor.ts` and
`.schemas.ts`, with its own helpers beside them and its errors in
`<step>.errors.ts`; `integrations` uses the same shape.

## Where new code goes

- A new step: its folder in the right area with the three files, then one
  line each in `catalog/definition-registrations.ts` and
  `catalog/executor-registrations.ts`.
- A pure decision a step makes: a function beside the step (`semantics.ts`,
  `lists/semantics/`), tested without an invocation.

## Defaults and config

- No environment. Step bounds live in each step's `.schemas.ts`; shared
  value bounds come from `node-sdk` (`NODE_JSON_LIMITS`,
  `STORED_EXECUTION_VALUE_LIMITS`, `FILE_PAGE_LIMITS`, `DATA_TABLE_LIMITS`).

## Rules

- An executor reads its invocation and returns a result or throws a
  `NodeExecutorFailure`; it keeps no state between invocations.

## Exceptions

- Two step families share one factory and keep one file per role for the
  family instead of one per step: data tables
  (`data/tables/data-tables.definition.ts`, `.executor.ts`) and utilities
  (`data/utilities/utilities.definition.ts`, `.executor.ts`, built with
  `define-utility.ts`, one folder per operation).
- Generic throws that stay are assertions: `data/date/format-instant.ts`
  (the fixed `Intl` formatter omitted a part), `data/read-file/csv/csv-records.ts`
  (a non-`Error` stream rejection, turned into a file failure by the catch
  below it) and `data/validate/semantics.ts` (a rule path the schema already
  checked).
- Limits are not yet named: nodes-core is outside the backend-limits check
  until its literals are named.

## What guards it

- `pnpm --filter @pertexo/nodes-core test`: every step's executor, the
  catalog's registrations, file reading and writing, lists, dates and
  utilities.
- `pnpm check`: package structure, naming, browser-entry and environment
  checks.
