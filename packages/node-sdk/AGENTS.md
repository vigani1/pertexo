# @pertexo/node-sdk

Follow the [root rules](../../AGENTS.md); this file only adds to them.

## Purpose and boundary

The contract between the engine and every step: what a step declares (its
definition, executor and policies in a node catalog), what it receives and
returns, how it fails, and the shared value rules (bounded JSON, stored JSON,
file pages, data tables, code steps) that both sides check the same way.
`nodes-core` and `integrations` implement it; `workflow-model`,
`workflow-engine`, `node-catalog`, the API, the worker, the code runner and
the web read it.

Two entries. `@pertexo/node-sdk` is safe in the browser: catalogs, schemas,
limits and pure checks. `@pertexo/node-sdk/server` is Node only: the node
registry, executor failures, bounded-JSON canonicalisation and file-page
writing. It depends on `zod` and `acorn` alone, never on another workspace
package, never reads the environment itself (`parseCodeSettings` takes the
caller's record) and never does I/O except through the runtimes a caller
hands an executor.

## Layout

- `src/index.ts`, `src/server.ts`: the entries.
- `definitions/`: the node catalog (`catalog.ts`) and its integrity error,
  identities, schema documents for the browser, output variants and
  labelled choices.
- `execution/`: the registry that runs executors, the request and result
  types, executor failures (`node-execution.errors.ts`), refusal wording and
  webhook responses.
- `values/`: bounded JSON (`bounded-json.ts`, `bounded-json.validation.ts`),
  stored JSON sizes and their error, canonical encoding, CSV formula safety
  and deep freezing.
- `artifacts/`: artifact references and their limits, file-input diagnostics
  and errors, sheet names, and `pages/` (file pages: encoding, writing,
  bundles and their errors).
- `code/`: code-step settings and container sizing (`code-settings.ts`), the
  runner protocol, framing, source checks and errors.
- `data-tables/`: data-table schemas, bindings, values and errors.
- `callbacks/`, `credentials/`, `run-values/`: callback types and codes, the
  signing-key credential, and run-value schemas.

## Where new code goes

- A new shared step contract: a schema or type in the area that owns it,
  exported from `index.ts` if the browser needs it, else from `server.ts`.
- A new executor failure: a class in that area's `.errors.ts`, extending
  `NodeExecutorFailure` with a closed `safeErrorCode`.
- A new bound: a named constant beside the schema that enforces it
  (`FILE_PAGE_LIMITS`, `DATA_TABLE_LIMITS`, `CODE_LIMITS`,
  `CODE_SETTING_BOUNDS`, `ARTIFACT_REFERENCE_LIMITS`, `NODE_JSON_LIMITS`);
  messages that state it are built from it.

## Defaults and config

- No environment of its own. Code-step settings (`DEFAULT_CODE_SETTINGS`,
  `CODE_SETTING_BOUNDS`) are parsed by `parseCodeSettings` from the record
  each app's config passes in.
- Limits: the tables above, each at the top of its file.

## Rules

- Browser and server check values the same way: the schema document carries
  `NODE_JSON_LIMITS`, and the registry admits with the same bounds.
- Failure text is closed: executor failures carry a safe code and, at most, a
  summary the step wrote for the person who built it.

## Exceptions

- `values/stored-json.ts` keeps its own JSON string byte count instead of
  workflow-model's `jsonStringByteLength`: stored execution text must be
  well-formed, so it refuses NUL and lone surrogates, where workflow-model
  measures any string as JSON writes it. The difference is deliberate.

- Generic throws that stay, each a programmer error:
  `definitions/schema-document.ts` (projection options out of bounds) and
  the two constructor guards in `execution/node-execution.errors.ts` (a
  failure or rate-limit error built with invalid fields).

## What guards it

- `pnpm --filter @pertexo/node-sdk test`: catalogs, the registry's bounded
  admission and dispatch, refusals, file pages, sheet names, data tables,
  code settings and source checks.
- `pnpm check`: package structure, naming, browser-entry, environment and
  backend-limits checks.
