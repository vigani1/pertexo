# ADR 032: Bounded deterministic Validate node

- **Status:** accepted
- **Date:** 2026-09-06

The V1 plan requires an executable Validate node, distinct from workflow-draft
validation and node-preview validation. Its behavior becomes part of immutable
published workflows, so it must be specified before adding `core.validate@1`.
We choose bounded static field rules and a typed validation result rather than
arbitrary schemas, expressions, regular expressions, coercion or user code.

## Decision

`core.validate@1` is a pure CPU node with no credentials, connections, network,
artifact writes or side effects. It accepts the normal bounded JSON node input
and a strict configuration containing an ordered `rules` array (1–64 entries).
Each rule has a unique `id` (1–64 ASCII letters, digits, underscore or hyphen,
starting with a letter), a `path`, and optional `required` (default false) and
`type` (`string`, `number`, `boolean`, `object`, `array` or `null`). Object means
a non-null non-array JSON object. No coercion or input mutation is permitted.

Paths use exactly the platform's existing JSON-path syntax and own-property
resolution, not a second dialect. Paths are at most 512 UTF-8 bytes and 64
segments. Config validation and execution share the same browser-safe path
parser/resolver; server-only expression evaluation remains separate.

Rules may additionally declare a nonempty `enum` of at most 32 distinct JSON
scalar values; `minimum`/`maximum` for type `number`; `minLength`/`maxLength`
for type `string`; and `minItems`/`maxItems` for type `array`. Bounds are
nonnegative safe integers except finite numeric minimum/maximum, and lower
bounds may not exceed upper bounds. Length means Unicode code points, not
UTF-16 code units. Enum strings are at most 256 UTF-8 bytes and an explicit
type must agree with every enum member. Unknown fields, duplicate rule IDs,
duplicate enum values, malformed paths, incompatible constraints and oversized
config/input are rejected rather than silently ignored. Version 1 has no
recursive/wildcard paths, regex, defaults, transformations or remote references.

A missing optional path passes; a missing required path fails. A present null
is not missing. Rules run in configuration order, producing at most one issue
per rule, with precedence required, type, enum, numeric bounds, string bounds,
then array bounds. Issue codes and messages are fixed versioned constants;
issues contain only `{ruleId,path,code,message}`, never observed input values.
Messages are at most 128 UTF-8 bytes. Each result contains at most 16 issues.
Evaluation stops at its issue limit; `truncated` states whether any remaining
rules were left unevaluated, not whether they would have failed.

Output is `{valid,issues,truncated}`: valid means every evaluated rule passed
and evaluation was complete. The node does not echo input; downstream mappings
may reference the original upstream value. A data mismatch is a successful
node execution with `valid:false`, allowing Condition/Switch to route it. It is
not a transport, configuration or internal failure and does not schedule a
retry. Invalid config/input and cancellation retain the normal executor failure
and cancellation contracts. A future fail-on-mismatch behavior requires a new
version rather than changing this identity.

## Acceptance and compatibility

The same pure config/rule implementation serves preview validation and the
registered server executor; `test_execute` uses the normal persisted worker
path. The manifest, executor ABI, schemas, static codes and resource/retry
metadata are pinned by the existing compatibility machinery. Add staged and
active releases after the retained catalog history; never rewrite a published
release, schema hash, executable or golden retained fixture.

Publishability requires config/rule/limit and deterministic-output tests;
browser/server registration bijection; cancellation and no-side-effect proof;
preview/runtime parity; staged-to-active compatibility and retained checksum
fixtures; and real persisted worker execution with duplicate delivery/recovery
assurance. Passing only a new executor unit test does not close IWA-15.

The trade-off is a deliberately smaller validation vocabulary than JSON Schema
and an explicit branch for invalid data. In return V1 has bounded work, fixed
diagnostics, no new evaluation language or failure taxonomy, and a stable
result that does not duplicate potentially sensitive input into run output.
