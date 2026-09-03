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
