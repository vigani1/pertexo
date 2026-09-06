# ADR 033: Truthful workflow activation projection

- **Status:** accepted
- **Date:** 2026-09-06

The Phase 2 authoring response deliberately exposed only `inactive` before
trigger reconciliation existed. That restriction now hides persisted trigger
health. Workflow summaries must expose the stored activation state using the
shared workflow-model vocabulary: `inactive`, `activating`, `active`,
`deactivating`, `degraded`, and `error`. Lifecycle (`active` or `archived`) and
activation remain independent fields; a read never infers health from the
presence of a published version or changes persisted state.

This supersedes only ADR 002's Phase 2-only public activation projection, not
its immutable-version, publication, tenancy, or durable-outbox guarantees.
Unknown stored states fail parsing rather than becoming a misleading
`inactive` response. Public response schemas and generated clients accept the
same vocabulary. The alternative of permanently keeping a separate, stale
authoring view was rejected because clients cannot reliably display the
workflow they just read.

This checkpoint does not complete IWA-16. Archive/restore commands, version
restoration, publication/trigger convergence, their concurrency semantics, and
their persisted execution evidence remain required and must be verified
separately.
