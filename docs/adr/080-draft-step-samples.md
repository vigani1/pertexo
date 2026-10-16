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
