# ADR 089: Canvas documentation and publication identity

Status: Accepted. Owner-approved F37, 2026-10-20.

## Decision

WorkflowGraph has one optional, bounded top-level `notes` array containing note
IDs, Markdown text, positions, sizes and preset colours. Notes document a graph;
they are not executable nodes or F19 discussion threads. Existing authoring
permissions, revisions, storage, retention and portability apply.

A published version retains its reviewed notes. A notes-only edit can therefore
create a new immutable version with the same executable checksum. Publication
reuse requires both the existing executable identity and identical note
metadata; absent notes and an empty list are equivalent. Existing step-position
and label-only reuse behavior is unchanged.

Remove the `(workflow_id, checksum)` uniqueness constraint. Keep immutable
version IDs, unique workflow/version numbers, workspace/version identities,
executable integrity checks and exact-version Call bindings. Notes are excluded
from compiled executables, checksums and pinned sample identities. No new hash,
stored format version, table, role or service is introduced.

## Consequences

Notes survive draft save, publication, restoration, duplication, import/export
and promotion. Version diffs describe note changes. Runs and Calls continue to
execute the exact immutable executable they accepted. Multiple retained versions
can share an executable checksum; a checksum alone does not identify one graph's
documentation. Existing version IDs remain authoritative.

This costs another ordinary version snapshot for a documentation-only
publication. A separate mutable documentation store would lose reviewed history
and introduce another ownership/retention path, so it is not used. Restoring the
old uniqueness constraint would require reconciling those retained versions;
this distinction is recorded here rather than hidden in a migration.
