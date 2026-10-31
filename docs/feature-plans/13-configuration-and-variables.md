# F13 — Workspace variables

Status: delivered, including immutable revision storage, descriptions and
publication checks (#309). Updated: 2026-10-16.
[Roadmap](../product-roadmap.md). Decision:
[ADR 078](../adr/078-run-variable-snapshots.md), including its revision amendment.
History stays in git and PRs.

## Decisions

Non-secret workspace text, finite numbers and booleans are reusable as
`$vars.NAME`. Editing affects new independent starts. Each run and preview
references an immutable variable-set revision; replay/recovery and child Calls
keep the source/parent reference. Never substitute current values for missing
history. Descriptions are settings metadata, not execution values.

## Rules

- Names match `[A-Z][A-Z0-9_]{0,63}`. At most 100 variables, 4,096 characters per
  text value and 32 KiB canonical values per workspace. False, zero and empty
  text are values. Valid Unicode/no NUL; no objects, arrays, null, credentials,
  interpolation or process-environment binding.
- All current members may read values. Owners/admins manage them through the
  existing capability. Explain visibility and direct secrets to Connections.
- Description: up to 500 plain characters each, 16 KiB total independently of
  values. Blank normalizes away; removal removes its description. Omitted update
  metadata preserves descriptions for retained names; explicit `{}` clears them.
- Replace the whole set with expected revision, current authority and stable
  command key. Lock the current head alone before reading its exact immutable
  set. Initial/concurrent edits return typed conflicts. Equivalent sets do not
  advance revision; metadata-only changes do. Audit names/revision, never values
  or descriptions. Rename is remove/add in the same edit.
- `workspace_variables` stores only the current-revision head. Immutable
  `workspace_variable_set_revisions` stores one values/descriptions row per
  workspace/revision. App roles insert/read, never update history.
- Runs/previews store workspace-bound revision foreign keys. Null is fixed empty
  revision zero, without a physical zero row. Existing detail-purge state, not
  null alone, distinguishes expired data. Pre-feature runs remain empty.
- Fresh independent admission holds the current head shared through reference
  insertion. Exact retries reuse acceptance. Replay/recovery hold the retained
  source; Calls inherit their parent's reference recursively. Error workflows
  are independent starts and capture current values at their own admission.
- Resolve values within existing scoped worker/preview reads, not a second query
  per step. Coordinator transitions carry only the revision; callable completion
  resolves lazily. Current settings use a consistent joined read. No second
  evaluator, mutable worker cache or full stored per-run copy.
- Direct mappings and the existing bounded JSONata runtime share one captured
  map and missing-name rule. Preserve expression policy pins and existing byte,
  depth/member/time limits. Exports carry references, never workspace values.
- Publication checks required typed/static `$vars.NAME`, including nested bodies
  and callable results, against the locked current set. Use the existing bounded
  off-thread authoring validator/AST inspection. Literal text is not a use;
  optional/dynamic lookups keep runtime semantics. Exact accepted publish retries
  remain accepted; fresh publication checks names even if reusing a version.
- Usage shows current readable drafts/publications and conservative dynamic or
  whole-map access. Respect pagination and authority; do not undercount by parsing
  only simple string occurrences. Show uses before removal and descriptions in
  settings/the mapping picker; preserve edits on conflicts or uncertain saves.
- Retain referenced revisions for live runs/human continuations. Terminal detail
  retirement and preview deletion release references; bounded retention deletes
  only noncurrent, unreferenced sets. Purge removes heads/executions before sets.
  Logical detail expiry refuses replay before physical cleanup.

## Ownership and slices

| Slice | Owner and status |
| --- | --- |
| Value/mapping/AST contracts | workflow-model; complete |
| Separate database area and Node-only `/variables` entry | Move-only commit; complete |
| Scoped current edits, usage and publication fence | core/variables + authoring; complete |
| Immutable sets, admission/worker references and lifecycle | Complete, migration 0016 |
| Descriptions, settings/picker and safe publish feedback | API/web; complete |

Qualification includes conflicting old snapshots, fixed-empty replay, concurrent
head edits/capture, missing static names, dynamic semantics, retained previews,
nested Calls, logical/physical retention/purge and real browser capture/replay.
A maximum 32,768-byte set is stored once for 50 admitted runs; their references
total 200 bytes. Full checks, mocked e2e, React Doctor and green CI precede merge.

## Rollout and later work

Stop old API/workers before migration 0016 removes per-run copies. Backfill
retained sets atomically and refuse inconsistent legacy revisions. Start matching
readers/writers together; never fall back to current values after restore or
retention. Environment-specific values, secrets and editable history UI remain
later work. See the [variables guide](../guides/variables.md).
