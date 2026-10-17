# ADR 080: Draft samples substitute editor tests, never published execution

- **Status:** accepted
- **Date:** 2026-10-16
- **Plan:** [F02](../feature-plans/02-workflow-test-workspace.md)

The owner authorized shared draft step samples. Keep them outside the workflow
graph and immutable publications: editor Test uses the existing durable preview
owner, while published starts/replay/recovery never accept overrides. Persist
ordinary bounded JSON with source provenance and a canonical behavior binding.
UI position/name changes preserve it; changed setup requires explicit confirmation
or replacement. File-backed samples are deferred rather than retaining expired
preview files through a second artifact lifecycle.

Substitution is a successful durable preview with a pinned marker and copied
output, without an attempt, provider credential access, outbox dispatch or fake
execution timing. Pin identity and draft setup are checked under the same
admission locks; a stale/missing expected pin refuses, never silently dispatches.
Exact accepted retries recover the original result before checking mutable pin
state. The API's earlier metadata check is advisory, not admission authority.

Keep one current row per step with a fresh opaque ID on each write. Explicit
remove/replacement erases its old payload; ordinary 30-day expiry, bounded
maintenance cleanup, workspace purge and authoring quotas own the rest. Preview
copies retain their existing seven-day lifetime. There is no revision archive,
numbered stored format, legal hold or new execution subsystem. This follows ADR
069 and replaces the pre-reset F02 plan's superseded machinery. Sample access
follows run-data visibility; only workflow editors may change it.

## Amendment — whole-draft tests (2026-10-16)

Owner-approved whole-draft tests freeze the saved draft and current pins as an
immutable test execution snapshot. Existing engine and worker execution rows
provide progress, cancellation and capacity; the snapshot is never a published
version. A `test` discriminator separates history, seven-day retention and all
terminal operational effects from real runs. Shared pins are copied at admission;
later changes never affect an accepted test. Test-only substitution cannot be
requested by published start, replay or recovery. See the F02 plan for the
execution rules and required isolation evidence.

## Amendment — serial test suites (2026-10-17)

Owner-approved suites execute up to 50 saved input cases through the same draft
test machinery. One immutable test source freezes graph, executable and pins for
the suite; cases reference it through the existing execution-source identity.
The source is owned by its workflow and retained references, rather than by its
first run. Backfill standalone snapshots without changing their value encoding
or letting them enter published execution. This avoids multiplying the largest
pin set by 50 and permits ordinary per-test retention without deleting a source
still used by another retained case. Only retention metadata may extend.

PostgreSQL stores the frozen manifest and serial progress; the existing worker
scanner settles and admits cases through ordinary test/run acceptance. One active
suite or standalone test per starter/workflow, current authority checks, unique
case/run bindings and existing receipts prevent duplicate work across crashes.
One acknowledgement covers the frozen suite's unpinned effects. No new engine,
service, queue, public testing authority or published override is introduced.
Publishing receives an advisory latest-result/freshness warning, never a gate.
