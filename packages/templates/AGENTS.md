# @pertexo/templates

Follow the [root rules](../../AGENTS.md); this file only adds to them.

## Purpose and boundary

The curated workflow examples: their reviewed portable manifests, pinned by
digest, the copy that describes them, and the check that a caller's manifest
is one of them with only the reviewed setup values changed. Browser-safe; it
depends on `workflow-model` alone. The web app shows and configures the
examples, `core` and the API create workflows from them, and `node-catalog`
adds the server-side check of setup values against the real node schemas.

It never resolves node definitions, touches a network or decides
authorization; a verified manifest still passes ordinary admission.

## Layout

- `src/index.ts`: the entry.
- `src/catalog.ts`: the examples, their copy and setup targets.
- `src/manifests/`: one reviewed manifest per example.
- `src/curated-template.validation.ts`: setup-value validation and manifest
  verification.
- `src/https-endpoint.validation.ts`: the curated HTTPS address grammar.

## Where new code goes

- A new example: a manifest in `manifests/`, an entry in `catalog.ts` with its
  digest, and its copy. `test/catalog.test.ts` pins the list and checks the
  copy's run duration against the manifest.
- A changed manifest: a new `templateVersion` and digest; never edit a
  published version in place.
- A new setup value kind: `CuratedTemplateSetupValueKind`, its validation in
  `curated-template.validation.ts` and its bounds exported for the web's hint.

## Defaults and config

No configuration. The curated setup bounds are
`CURATED_HTTPS_ENDPOINT_LIMITS` and `CURATED_SLACK_CHANNEL_ID_LENGTH`; the web
reads them for its hints.

## Rules

- Validation never coerces, trims or normalises a submitted value.
- A limit an example states in its copy is its manifest's own value, and a test
  ties the two.

## Exceptions

- The root files beside the entry are listed with their reasons in
  `ROOT_CONCEPTS` (`infrastructure/checks/validate-package-roots.mjs`).
- The examples' titles and summaries are user-facing text outside the web
  app: they are reviewed and versioned with the manifests they describe, and
  the web shows them as given.

## What guards it

- `pnpm --filter @pertexo/templates test`: digests, verification, setup
  validation and the HTTPS grammar's corpus.
- `pnpm check`: package structure, naming, environment and backend-limits
  checks.
