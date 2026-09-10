# Supported export surface

`pnpm dependencies:check` runs the pinned workspace-aware Knip analysis over
production, test, generated-contract, and explicit package entry points. The
gate rejects unused/unlisted dependencies, files, value exports, type exports,
and duplicate aliases.

Package `exports` maps and application composition entry points are supported
boundaries even when this repository is their only current consumer. They are
kept explicit rather than deleted from a static zero-consumer result. Symbols
inside an application or behind an unexported package source path default to
private and are exported only when a production composition root, a supported
package subpath, or an owner-local test boundary consumes them.

Two formerly same-object schema aliases remain intentionally separate public
concepts without being duplicate exports:

- failure-notification destination configuration and its create-request body
  currently accept the same shape but have different wire evolution pressure;
- core merge input and output currently share one ledger shape but represent
  opposite sides of the node contract.

Each semantic view carries distinct schema metadata, allowing documentation
and future evolution without copying validation rules or exposing an
unreviewed alias.

## Application entrypoints and request types

Nest application composition roots and package `exports` maps are the only
supported cross-owner entrypoints. Feature-local barrels, `module.ts` files and
runtime factories are navigation/composition seams; they are not a reason to
promote their private helpers to package exports. The current built-export gate
loads 14 Node/browser consumer cases and remains the executable inventory.

For authenticated API routes,
[`IdentityWorkspaceRequest`](../../apps/api/src/identity-workspace/types.ts)
owns the shared authenticated identity, authorized workspace, request/trace
identifiers, headers and operation signal. Feature transport request types use
`Pick`/`Omit` or intersections to select that vocabulary, adding only a field
their HTTP controller actually receives. They remain distinct from application
`*Input` types, which carry parsed identifiers, actor context and command data
but never raw headers, response-close callbacks or Nest/Fastify request state.

The behavior-level route from public entrypoint to policy, persistence,
resource and test owner is maintained in the
[codebase map](../codebase-map.md#behavior-to-owner-routes). This document owns
which surfaces are supported; that map owns where behavior is implemented.
