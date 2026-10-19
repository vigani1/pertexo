# ADR 088 — Step data and graphs keep their key order

Status: accepted. Date: 2026-10-19. Plan: [step capability upgrades](../feature-plans/step-capability-upgrades.md).

People read step data in the order it was written: a CSV's columns, a form's
fields, a Set step's fields as laid out in the editor. n8n, Zapier and Make all
keep that order. Pertexo lost it in three places. PostgreSQL `jsonb` sorts keys,
the stored-value serializer wrote sorted text, and the engine, mappings and
expressions normalized every value through sorted canonical JSON. The owner
approved keeping the order.

Columns that hold step data or graphs use `json`, which stores the text as
written. They are run input and output, step input, output and failure, attempt
output, task output, call input and result, coordinated-event input, replay input,
preview input, output and node, preview attempt output, draft and version graphs,
the version executable, and test snapshot graphs, executables and pins. Table rows
and pinned samples were already text. Table rows are written and read in column
order. Run checkpoints, events, outbox payloads, receipts and configuration keep
`jsonb`: they are engine or platform state, not data people read.

TypeScript keeps one rule for each use. `normalizeJson` validates a value and
keeps its order, for data that flows to steps and storage. `canonicalJson` sorts
keys, for hashes, checksums, idempotency and equality. Stored values compare in
canonical form, so a row written before this change, in sorted order, still
equals the same value written after it. Mappings resolve in authored order. The
engine still sorts its own structures, such as policies in the checkpoint, and
compares them canonically.

SQL that needs `jsonb` operators casts the column in place, for example
`executable_json::jsonb @> …`. Writes cast parameters to `json`, never `jsonb`,
because a `jsonb` cast sorts the keys before the value reaches the column. `json`
has no equality operator, so comparisons cast both sides to `jsonb`. Rows written
earlier keep the sorted order they already have. JavaScript puts integer-like keys
such as `"2024"` first in any object, so those keys can't keep their written
position.
