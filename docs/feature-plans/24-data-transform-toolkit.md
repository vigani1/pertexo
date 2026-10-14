# F24 — Discoverable bounded data transforms

Status: approved for planning, review and implementation by the owner on
2026-10-14, after the completed F09 first release, and before F16.
Parent: [product roadmap](../product-roadmap.md). Reconciled baseline:
`2adb1a853f7200f20a4db513f9ddb4c2576f2815`.

## Outcome and release scope

An editor can prepare a bounded JSON collection without writing a predicate or
sorting expression: filter invoices, sort them by amount, retain one invoice per
ID and summarize amounts. The same published workflow can run, be tested,
exported/imported and used within a For each body. Its history shows ordinary
inputs/outputs and fixed failures through the existing execution engine.

Deliver four focused collection steps (`core.filter`, `core.sort`,
`core.unique`, `core.summarize`) and a deterministic date conversion step
(`core.date`). Each has definition/config/executor version 1, the existing
`in`/`out` ports, transform family, safe retries, CPU resource class, no
connection requirements, the existing bounded-JSON policy and the existing
restricted-JSONata policy for ordinary input mappings. These are pinned
node releases, not a new stored format, expression language or batch subsystem.

Text normalization, case conversion, joins and simple number conversion use
short discoverable examples in the existing expression editor. They keep the
restricted JSONata evaluator; no trivial extra nodes or expansion of its
allowlist. A recipe is editable expression source, not separately persisted
policy or execution. Never imply a recipe previews provider effects.

File CSV/JSON conversion stays gated on F04's artifact/file consumer contracts.
There is no file consumer to wire today. Stateful cross-run deduplication,
streaming, arbitrary comparators, regex, locale sorting, arbitrary date-format
patterns, named timezone databases and decimal financial arithmetic are outside
this release. This does not mark those deferred capabilities done.

## Current inventory and why these owners

| Need | Existing foundation | Increment |
| --- | --- | --- |
| Build an object/map fields | `nodes-core/src/set/`, ordinary input mappings | Keep Set and mapping semantics |
| Validate records | `nodes-core/src/validate/` with fixed issue output | Keep Validate; transforms fail on invalid input rather than emit validation reports |
| Filter a collection | JSONata path filters | Add discoverable scalar comparison controls; no second expression evaluator |
| Sort | Restricted profile lacks `$sort` and rejects unsupported AST constructs | Dedicated stable numeric/code-unit sort; do not relax ADR 009 |
| Unique values | `$distinct`, already allowed | A visible keyed/whole-value step with explicit missing-key behavior and counts |
| Summarize | `$count/$sum/$min/$max/$average`, already allowed | One visible bounded grouping/numeric summary, not separate cosmetic arithmetic nodes |
| Text/number preparation | Existing allowed `$trim/$uppercase/$lowercase/$join/$number` | Editable examples in the existing expression field |
| Date conversion | No clock/date built-ins in the restricted evaluator | Strict explicit-offset instant ↔ epoch milliseconds, always UTC output |
| Batch work | Existing For each, maximum 1,000 items | Operate once on a bounded collection; no new scheduler/streaming claims |

Canonical paths are `packages/nodes-core/src/<area>/` with
`definition.ts`, `validation.ts`, `executor.ts`, `index.ts`; pure collection
semantics shared by the four new executors live in private `src/collections/`
files by responsibility. Definition registration remains in `definitions.ts`,
executor registration in `registrations.ts`, catalog composition in
`node-catalog`. No new package or consumer-named entry point.

Shared primitives stay with their existing owner: workflow-model's
`parseJsonPath`, `resolveJsonPath` and `canonicalJson`; node-sdk's JSON bounds,
schema generation, registry input/config/output validation, cancellation and
safe error projection. Do not move node-specific rules to the engine or database.

## Exact collection contract

All collection inputs are ordinary objects with an `items` array, maximum
1,000 elements. Reject a missing array, null, non-array, sparse array, non-JSON
value or repeated/cyclic reference through the existing SDK boundary. The
whole input/output still obeys the existing inclusive 1 MiB, depth 64 and
10,000-member limits. Do not raise global bounds or claim unbounded batches.
Validate the complete input once at registry admission, then trust typed values
inside private semantics. Config-dependent semantic checks occur in the
executor; failures have fixed messages/codes and never echo observed records.

Paths use the existing own-property JSON path syntax, max 512 UTF-8 bytes and
64 segments; `$` means the item itself. No wildcards, recursive traversal or
prototype lookup. Parse the configured path once per operation, not per
comparison in sorting. Node config declarations name these runtime-only limits
through existing schema metadata. JSON Schema is advisory where it cannot
express cross-field/aggregate semantics.

| Step | Config and defaults | Input | Output |
| --- | --- | --- | --- |
| Filter items | `path: '$'`, `operator: 'equals'`; scalar comparison operations below | `items`, optional scalar `value` | `items`, `inputCount`, `removedCount` |
| Sort items | `path: '$'`, `valueType: 'number'`, `direction: 'ascending'`, `missing: 'last'` | `items` | `items`, `inputCount` |
| Remove duplicates | `path: '$'`, `missing: 'error'` | `items` | `items`, `inputCount`, `duplicateCount`, `skippedCount` |
| Summarize items | `valuePath: '$'`, optional `groupBy`, `missing: 'error'` | `items` | `groups`, `inputCount`, `skippedCount` |

Workflow editors own these settings through ordinary draft/save/publish
capabilities. There is no workspace transform preference or separate audit
channel; existing authoring/publication audit applies. Security/resource bounds
cannot be disabled. A missing-value setting may only choose its declared
behavior; it cannot disable type or output validation.

### Filter

Operators: equals, not-equals, less-than, less-or-equal, greater-than,
greater-or-equal, contains, exists and not-exists. The form displays plain words.
Comparison `value` comes from ordinary input mappings (including literal or
current run data), not a duplicated config expression. All comparison operators
require it; exists/not-exists do not use it.

Equality is strict scalar equality without coercion: `1` differs from `"1"`,
null differs from missing. Numeric comparisons require numbers, contains
requires strings and uses case-sensitive substring matching. Invalid selected
value types fail the step, rather than silently discard bad records. Missing
paths never match a comparison, including not-equals. Exists means an own value
is present, including null; not-exists means missing. Objects/arrays at a
comparison path fail, while exists can check their presence. Kept items preserve
input order and data. Empty input returns `items: []` and zero counts.

### Sort

Sort numbers numerically or strings by UTF-16 code-unit order using `<`/`>`;
never `localeCompare`. All present non-null keys must match configured type.
Missing/null keys occupy the configured first/last bucket regardless of sort
direction. Null/missing ordering within that bucket and equal-key ordering stay
stable in original input order. Sorting returns a new array and never mutates
input. Project keys once; bounded O(n log n) sorting, no path/JSON serialization
inside its comparator. Explain beside missing-value control that records remain
in the collection.

### Remove duplicates

Retain the first item for each selected value and preserve original order.
Whole-value equality uses the shared canonical JSON string: object key order is
irrelevant, array order and scalar type are significant, null is a real key and
negative zero follows existing canonical normalization. Keyed deduplication uses
the same equality for the selected value. No hash-only collision shortcut and
no new canonicalization helper.

A missing key fails by default. Explicit skip removes those items and reports
`skippedCount`; duplicates report `duplicateCount` separately. Kept + duplicate
+ skipped equals input count. No memory across runs and no database lookup.
Bounded O(n) map/set work plus bounded canonicalization of actual key values.

### Summarize

Each included record supplies a finite numeric value. Grouping is optional;
selected group keys are scalar string/number/boolean/null and are compared with
canonical typed equality. Groups appear in first-seen order. Each result is
`{ key, count, sum, min, max, average }`; no arbitrary output-field expressions.
Without grouping, empty input returns one null-key group with count/sum zero
and min/max/average null. With grouping, empty input returns no groups.

Missing/null numeric values or a missing group key fail by default. Explicit
skip excludes them and reports the global skipped count. Wrong non-null types
fail in either mode; skip does not coerce strings into numbers. Reject non-safe
integer operands/intermediate results and non-finite arithmetic. Decimal inputs
use deterministic IEEE-754 arithmetic in input order; no silent rounding or
promise of exact monetary arithmetic. Zero and negative numbers are valid.
Cancellation is checked during bounded loops; group count cannot exceed items.

## Date and existing-expression recipes

`core.date` config chooses `operation: 'to_iso'` (default) or
`'to_epoch_millis'`. Input is `{ value }`; output is `{ value }` with the selected
result type. To ISO requires integer epoch milliseconds within UTC years
0000–9999. To epoch requires a strict valid calendar timestamp
`YYYY-MM-DDTHH:mm:ss[.SSS](Z|±HH:mm)`; optional fraction has 1–3 digits.
Timezone offset is mandatory; the RFC 3339 `-00:00` marker still denotes a
known UTC instant and does not supply a local zone. See
[RFC 3339 §4.3](https://www.rfc-editor.org/info/rfc3339/). leap seconds and 24:00 are rejected, calendar days
and leap years are checked, and the resulting UTC instant must remain within
0000–9999. Output ISO is canonical UTC with three millisecond digits.

No local timezone, implicit seconds/milliseconds guess, Date.now, natural-date
parsing or invalid-day rollover. DST folds/gaps are not inferred: a supplied
explicit offset defines the instant. Same input yields same output after restart
and under different host TZ settings. Plain form explains units/offsets.

Expression examples cover trim, uppercase, lowercase, join and number conversion
using only the current allowlist. Existing expression editor displays source and
an example input/result; choosing an example fills editable source and requires
review of the actual data path. It does not create mappings, rows, namespaces or
sample execution automatically. Preview continues through the production
restricted evaluator. Unit cases validate example syntax and golden output,
including missing/null/wrong-type behavior; no alternative evaluator in web.

## Frontend placement and behavior

Existing catalog presentation owns the five names/icons/descriptions and
schema-driven Setup owns fields. Prefer standard title/description/enum
metadata and existing SchemaField controls; add a focused node builder only when
conditional presentation cannot preserve valid settings through those controls.
The Inputs tab uses existing suggestions/data picker and human labels for items,
comparison value and date value. Output schemas expose exact fields for the next
step's ordinary mapping.

Keep feature-local pure recipe descriptions under editor `model/inspector/` and
recipe UI under `components/inspector/input-mappings/`; compose it into the
existing expression field. No global recipe store, new feature shell or Query
request for static examples. Keep authored source in the scoped draft and
serialized ETag save flow. New-step defaults use existing `model/graph/starting-config.ts`; require exact
config in the server schema instead of applying Zod defaults during admission.
Preserve undo/redo, raw JSON editing, import/export,
read-only roles, conflicts and invalid values with messages rather than dropping
them during presentation changes.

Weft glyphs, thread flow, normal input/output inspection and plain forms remain.
Keyboard/focus, 375 px × 768 px, reduced motion and scrolling are required.
Backend remains authoritative; display sample data as examples, never run truth.

## Delivery and verification

One coherent PR per slice, rebase-merge green before next. Pure moves, if needed,
have separate commits; no extra folder scaffolding. Every commit passes relevant
lint, types and units; visible code also passes build, mocked browser tests and
changed-code React Doctor without suppressions. Normal pre-push hook runs.

| Slice | Result | Evidence |
| --- | --- | --- |
| 0. Plan/inventory/review | Reconciled exact semantics, placement and dependencies | Review findings below; docs PR and existing checks |
| 1. Collection/date runtime | Five versioned nodes, exact schemas, bounded pure executors, pinned registration | Registry golden tests, type/null/missing/order/empty/bounds/abort, compiler/catalog/portable compatibility, no mutation, TZ/restart stability |
| 2. Product and qualification | Names, usable forms, expression examples, user docs | Full mocked browser tests plus existing owned browser/API/database/queue/worker journey author/save/reload/publish/run/output; loop-body use; screenshots; retained old versions execute |

Use existing real browser/editor fixtures and existing CI jobs. Add a scenario
to their existing case loop when needed, with actual browser authorship and
independent database/output assertions. Never seed a graph and call it browser
qualification. No external provider account or real service call is needed.
API/worker share the same node registry; preview and durable run outputs must
match. Existing engine/queue/checkpoint/capacity/recovery policy stays unchanged.
New ordinary transform definitions can use existing F09 source eligibility,
subject to all its actual outcome and shape limits.

Test maximum 1,000 items and reject 1,001; keep byte/depth/member bounds, finite
numbers, Unicode/code-unit ties, null vs missing, hostile paths, mixed types,
reordered object keys, numeric overflow, cancellation and old manifest pins.
Record a bounded 1,000-item CPU/memory measurement through registry execution;
there is no artificial throughput/SLA or server-RAM claim. Review unnecessary
passes, avoid comparator work and caches, and investigate repeatable regressions.

No new SQL table/migration, stored format, role, API endpoint, service, dependency,
CI job or cross-cutting ADR is required. Existing node-version/policy decisions
cover these routine releases; exact semantics are pinned in manifest metadata
and this plan. Any actual need beyond these owners triggers the root stop rule.

## Plan review (2026-10-14)

Reviewed against current code, ADR 009 (restricted profile), SDK admission,
portable config equality and editor state ownership before implementation.

- Rejected one generic union-heavy Transform node: its interface exposes every
  operation's settings and requires a new variant/palette policy. Four named
  steps share only genuine collection primitives and have small exact schemas.
- Kept Set/Validate and simple text/number operations in their existing owners;
  avoided new runtime evaluation or expanding the expression capability profile.
- Separated null from missing and stable/code-unit ordering from host locale.
  Defined empty grouped vs ungrouped output and skip counters before coding.
- Bounded paths, collection sizes, whole JSON and numeric arithmetic; no
  per-item JSONata workers, per-item SQL, streaming claim or speculative cache.
- Removed ambiguous natural-date/DST inference; a strict explicit offset and UTC
  milliseconds provide deterministic useful conversion without a timezone service.
- Resolved portable imports: new-step defaults are materialized by existing
  `starting-config.ts` during authoring; publication/export keep exact saved config. Do not rely on schema
  defaults to silently alter imported or retained config.
- File parsing remains explicitly dependent on F04. F16 starts only after this
  supported release is verified/merged and gets a separate identity/auth review.

Primary references checked 2026-10-14:
[JSONata array functions](https://docs.jsonata.org/array-functions),
[aggregation functions](https://docs.jsonata.org/aggregation-functions),
[n8n docs](https://docs.n8n.io/). Their broader behavior does not expand Pertexo's
restricted profile or define its identity/persistence contracts.

## Tracker

- [x] Owner authorized F24 planning/review/implementation before F16.
- [x] Current baseline, inventory, decisions and module placement reconciled.
- [x] Plan reviewed; boundaries and deferred file dependency made explicit.
- [x] Slice 0: PR #279 merged after all required CI passed.
- [ ] Slice 1: runtime implemented; local semantic and durable-worker qualification
  passed. Full verification and PR merge remain required.
- [ ] Slice 2 frontend and real integrated qualification verified/merged.
- [ ] Final CI/postmerge evidence recorded on each slice PR.
- [ ] F04 file consumer/conversion separately planned and authorized.

### Slice 1 local evidence

The real PostgreSQL/Redis fixture compiles an immutable workflow and executes
all five transforms in two For each body invocations through the compiled
coordinator, outbox dispatcher and attempt worker. It checks persisted results,
existing Manual/Set/For each/Stop v1 nodes and a restricted expression mapping.
It owns a disposable database; no application database or services are reset.

Bounded measurement on Node 24.15.0, arm64: 1,000 three-field records, five warmup
calls followed by 50 registry executions per operation. Median/p95 milliseconds:
Filter 3.22/4.12, Sort 3.13/4.06, Unique 2.21/2.73, Summarize 1.42/2.33.
Observed heap growth over the 50-call batches was 24–37 MiB before GC;
retained growth after GC was 0.02–0.05 MiB. These include admission/output
validation and are local observations, not per-call allocation or a server SLA.

No production deployment or provider provisioning is part of this work.
