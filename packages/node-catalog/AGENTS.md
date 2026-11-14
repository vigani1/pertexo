# @pertexo/node-catalog

Follow the [root rules](../../AGENTS.md); this file only adds to them.

## Purpose and boundary

The one platform catalog: every core node and integration the product
serves, joined from `nodes-core` and `integrations`, with the policies built
on it. The root entry is browser-safe (the catalog, its browser projection,
definition lookup, the portable-definition policy); `/server` assembles the
executing registry with injected provider clients. The API, the worker and
the web app use it.

It never defines a node (nodes live in `nodes-core` and `integrations`),
never creates provider clients (callers inject them) and never reads
configuration.

## Layout

- `src/index.ts`, `src/server.ts`: the entries.
- `src/catalog.ts`: the catalog, its registrations and definition lookup.
- `src/browser-catalog.ts`: what browsers see of each definition.
- `src/portable-definition-policy.ts`: import and export admission per
  definition.
- `src/curated-template-policy.ts`: curated setup checked against the real
  node schemas.
- `src/node-catalog.errors.ts`: lookup and policy failures.

## Where new code goes

- A new integration: register it in `catalog.ts` (definition, manifest,
  policies) and, if it executes, in `server.ts`'s registry.
- A new connection slot: `CONNECTION_SLOT_POLICIES` in
  `portable-definition-policy.ts`.
- A new browser field: `PlatformNodeDefinitionBrowserProjection` and its
  projection in `browser-catalog.ts`.

## Defaults and config

None: node limits and defaults belong to each node's definition.

## Rules

- A lookup of an unknown definition throws
  `PlatformNodeDefinitionUnavailableError`; callers that turn it into an issue
  catch only that error.

## Exceptions

- Its five root files (the catalog, its browser projection, the two policies
  and the errors) sit at the `src` root: the package is one small area, and
  each is the catalog's one view of its kind. Their reasons are in
  `ROOT_CONCEPTS` (`infrastructure/checks/validate-package-roots.mjs`).

## What guards it

- `pnpm --filter @pertexo/node-catalog test`: projection, lookup, portable
  policy, template setup, the registry and structured execution.
- `pnpm check`: package structure, naming, environment and backend-limits
  checks.
