# ADR 078: Run snapshots of workspace variables

- **Status:** accepted under the owner's autonomous feature instruction
- **Date:** 2026-10-15
- **Plan:** [F13](../feature-plans/13-configuration-and-variables.md)

## Context

Reusable non-secret configuration must not change halfway through a run or make
replay silently use today's values. All starts already share transactional
admission; durable attempts and callable completion load values under the same
workspace/run authority. Restricted JSONata has one bounded isolated runtime.

## Decision

### Amendment: immutable variable set revisions (2026-10-16)

The owner requested shared immutable sets instead of a full stored copy per run
and preview. This supersedes the per-run JSON storage clauses below. Store one
workspace/revision row per change, containing values and optional descriptions,
and keep a small current-revision head. Runs/previews reference the captured
revision by workspace-bound foreign key. Null references represent the fixed
empty revision zero; existing detail-retention state distinguishes expired data.
Never replace a missing historical revision with current values.

Current-head capture holds a shared lock through admission; replay/recovery hold
the retained source while copying its reference. Calls inherit it. Lock heads
alone before reading their exact immutable set, so concurrent edits cannot mix
revision and content. Bounded retention removes only noncurrent, unreferenced
sets; run detail cleanup and preview deletion release references. Workspace
purge removes heads and executions before revisions. App permissions do not
allow revision updates. Migrate existing snapshots without changing their values,
and stop old API/worker readers before the coordinated schema/binary rollout.
The owner briefly disables forced row security on previews inside the migration
transaction to update all workspaces, then restores it before commit; the usual
owner policy only permits workspace-scoped preview updates.

Publication checks required static variable names using the existing bounded
authoring worker and its AST inspection. Optional/dynamic lookups keep their
runtime semantics. Descriptions are non-secret settings metadata, not execution
values: 500 characters each, 16 KiB total. Omitted update metadata preserves
descriptions for retained names; an explicit empty map clears them. Empty
descriptions normalize away, and metadata changes advance the same CAS revision. The database variable area has its own Node-only `/variables` entry point;
no new service, role, cache or editable history UI is introduced.

Store one bounded current workspace map of text, finite number and boolean values
with a CAS revision. Current members read it; owners/admins manage it. No process
environment, secret material, per-workflow ACL, version-history service or extra
runtime. Audit stores names/revision only. Values are explicitly visible to every
member; Connections remain the credential authority.

At admission, each independent run captures a reference to the current immutable
set in its retained details; read responses resolve `{ revision, values }`. Exact command retries keep the accepted snapshot. Full replay
and step recovery retain their source reference, including when another published
version is selected. Child Calls inherit the parent snapshot recursively. Error
workflows are independent starts and capture the current set; no source snapshot
is added to their safe failure summary. Previews capture current values at their
own admission. Existing pre-feature runs have an empty revision-zero snapshot.

Workers resolve variables from the captured run/preview only. Snapshot access
uses existing attempt fencing and run-read authorization. Live runs retain them;
ordinary detail retention clears them. A purged replay/recovery source refuses
instead of substituting current configuration. Workspace purge removes current heads, execution references and immutable sets.

Expose a typed direct variable ValueSource, displayed as `$vars.NAME`, on every
mapped input. Existing JSONata-capable nodes and callable expressions additionally
bind `$vars` for computed values. Preserve per-definition expression policy pins;
a simple lookup does not require an expression worker. Both paths use one captured
map and one missing-name rule, within the existing graph/executable envelopes. This amends ADR 009's named-variable exclusion for exactly one
immutable data binding. It adds no operators, host functions, arbitrary named
bindings, graph format or competing expression policy. Existing expression byte,
depth/member and runtime limits include the copied values. Direct missing names
fail clearly; dynamic/whole-map access is conservative in usage reporting.

Usage reports current drafts and current publications, including body mappings
and callable results, under current workflow-read authority. Parsed AST facts
separate static names, whole-map/dynamic accesses and ordinary literal text.
Exports contain mapping references only, never workspace values; imports resolve names
in the destination workspace.

## Consequences

Editing configuration affects only new independent runs. A logical run stays
consistent across waiting, retries, replay/recovery and subworkflows without
worker-side mutable lookups or caches. Retention deliberately limits historical
replay. Additive schema and matching API/worker readers precede new mappings.
Environment-specific values, secret variables and historical editable revisions
remain later work rather than speculative machinery.
