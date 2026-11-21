# @pertexo/node-catalog

Follow the [root rules](../../AGENTS.md); this file only adds to them.

## Purpose and boundary

The one platform catalog: every core node and integration the product
serves, joined from `nodes-core` and `integrations`, with the policies built
on it. The root entry serves the API and worker. The API exposes its browser
projection as data through the catalog routes. `/server` assembles the
executing registry with injected provider clients.

It never defines a node (nodes live in `nodes-core` and `integrations`),
never creates provider clients (callers inject them) and never reads
configuration.

## Layout

- `src/index.ts`, `src/server.ts`: the entries.
- `src/integration-modules.ts`: the explicit integration registry and startup checks.
- `src/catalog.ts`: the catalog, its registrations and definition lookup.
- `src/browser-catalog.ts`: what browsers see of each definition.
- `src/portable-definition-policy.ts`: import and export admission per
  definition.
- `src/curated-template-policy.ts`: curated setup checked against the real
  node schemas.
- `src/node-catalog.errors.ts`: lookup and policy failures.

## Where new code goes

- A new integration: register its module in `integration-modules.ts` and,
  if it executes, wire its executor in `server.ts`.
- A new connection slot: declare it with its owning integration connection.
  `portable-definition-policy.ts` derives the portable slots from the registry.
- A new browser field: `PlatformNodeDefinitionBrowserProjection` and its
  projection in `browser-catalog.ts`.

## Defaults and config

None: node limits and defaults belong to each node's definition.

## Rules

- A lookup of an unknown definition throws
  `PlatformNodeDefinitionUnavailableError`; callers that turn it into an issue
  catch only that error.

## Exceptions

- Its root files (the catalog, its browser projection, the two policies
  and the errors) sit at the `src` root: the package is one small area, and
  each is the catalog's one view of its kind. Their reasons are in
  `ROOT_CONCEPTS` (`infrastructure/checks/validate-package-roots.mjs`).

## What guards it

- `pnpm --filter @pertexo/node-catalog test`: projection, lookup, portable
  policy, template setup, the registry and structured execution.
- `pnpm check`: package structure, naming, environment and backend-limits
  checks.
