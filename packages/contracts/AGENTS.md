# @pertexo/contracts

Follow the [root rules](../../AGENTS.md); this file only adds to them.

## Purpose and boundary

The HTTP contract between the API and its clients: every route's path,
parameters, request and response schemas, the problem codes the API answers
with, and the OpenAPI documents built from them. The API validates requests
with these schemas, the web and CLI parse responses with them, and
`integrations`, `secrets`, `database` and `core` reuse its vocabularies.

Two entries. `@pertexo/contracts` is safe in the browser: schemas, problem
codes and types. `@pertexo/contracts/server` is Node only: route tables and
OpenAPI documents. It depends on `@pertexo/workflow-model`,
`@pertexo/node-sdk`, `@pertexo/policy` and `zod`. It holds no behaviour
beyond parsing: it never decides, stores or calls anything. `core` may import
its types, never its runtime schemas (a lint rule enforces it).

## Layout

- `src/index.ts`, `src/server.ts`: the entries.
- `schemas/`: request and response schemas by area (`connections/`,
  `execution/`, `forms/`, `identity/`, `notifications/`, `triggers/`,
  `workflows/`, `shared/`).
- `routes/`: one route table per area, built with `defineRoute`
  (`routes/define.ts`), plus the OpenAPI primitives and schema projection.
- `errors/`: the problem-code registry (`api-problem.ts`) and the problem
  codes and details each area adds to it (`errors/workflows/`, `forms.ts`,
  `callbacks.ts`, …).
- `openapi/`: one OpenAPI document per area, the public document, problem
  responses and the list of generated artifacts.
- `artifacts/`: the generated OpenAPI JSON, written by
  `pnpm --filter @pertexo/contracts contracts:generate` (`scripts/generate-artifacts.ts`).

## Where new code goes

- A new endpoint: its schemas in `schemas/<area>/`, its route in
  `routes/<area>/` through `defineRoute`, its operation in the area's
  `openapi/` document, then `contracts:generate`.
- A new problem code: in the area's `errors/` file, joined into
  `API_PROBLEM_CODES` and `API_PROBLEM_MANIFEST` in `api-problem.ts`.
- A shared field schema: `schemas/shared/`.

## Defaults and config

- No environment. Field bounds sit beside their schemas or come from their
  owners (`WORKFLOW_GRAPH_CONTRACT_LIMITS`, `PENDING_TASK_LIMITS`,
  `WORKFLOW_PORTABILITY_LIMITS` in `workflow-model`).

## Rules

- A route's path parameters and its parameter schema name the same things;
  `defineRoute` refuses a route where they differ.
- The generated artifacts always match the schemas: `contracts:check`
  regenerates and compares them, then lints them with Redocly.

## Exceptions

- `errors/` files are named by area, not `.errors.ts`: they are problem-code
  vocabularies on the wire, not error classes. The one error class,
  `SamlHttpsOriginRequiredError`, is in `schemas/identity/federation/federation.errors.ts`.
- `errors/api-problem.ts` is exempt from the line limit: it is the one
  registry of problem codes, read whole (see `eslint.config.mjs`).
- Generic throws that stay: `routes/define.ts` and `openapi/public.ts`
  (route and document assembly at module load, programmer errors);
  `schemas/execution/runs.ts` (a timestamp its schema already admitted);
  `schemas/identity/federation/settings.ts` and
  `schemas/workflows/input-cases.ts` (bare throws caught in the same
  function and turned into schema issues).
- Limits are not yet named: contracts is outside the backend-limits check.
  Most of its literals are HTTP status codes and field bounds, and the check
  needs a rule for status codes first.

## What guards it

- `pnpm --filter @pertexo/contracts test`: schema behaviour, route
  declarations and parameters, response compatibility, the browser entry and
  the generated artifacts.
- `pnpm contracts:check` (part of `pnpm check`): regenerated artifacts and
  Redocly lint.
- `pnpm check`: package structure, naming, browser-entry and environment
  checks.
