# Database migrations 0082–0086

Date: 2026-09-12. All five files fully read by the primary reviewer. No database
service or migration was executed in this final group.

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `packages/database/migrations/0082_legal_hold_destruction_serialization.sql` | KEEP; shared WQ-193 | Acquires matching workspace advisory lock before workspace row; validates required scalar inputs before exact command replay and append-chain mutation. Repetition of placement/release fields preserves the durable command fingerprint. It serializes local projection, not an external ledger append by itself; WQ-193 owns cross-system high-water correctness. This migration does not replace transient reaping. |
| `packages/database/migrations/0083_artifact_finalization_retention_deadline.sql` | KEEP; conditional populated-upgrade evidence | Explicit per-workspace context makes FORCE-RLS backfill visible, extends only finalized available user uploads, and grants just the deadline column. Short routine is clearer than a generic migration helper. Verify large populated installations fit migration deadlines; do not rewrite history or assert online backfill qualification from static tests. |
| `packages/database/migrations/0084_workspace_member_discovery_index.sql` | KEEP | Partial index matches discovery membership statuses and deterministic keyset ordering. Atomic build fits existing runner architecture; large-table lock-time qualification is conditional operational evidence, not grounds for switching all migrations to nontransactional mode. |
| `packages/database/migrations/0085_artifact_media_type_http_safety.sql` | KEEP | Retains existing loose MIME grammar while enforcing Node-compatible header bytes. Column already NOT NULL; no new CHECK-NULL hole. NOT VALID plus VALIDATE fails closed on old unsafe rows. Existing malformed-row handling should be documented as an upgrade prerequisite, not silently sanitized. |
| `packages/database/migrations/0086_operator_attempt_reclaim_state.sql` | KEEP | Owner wrapper restores context on success/error and requires exactly one matching running node to become ready in the same transaction as a nonreplayed reclaim. Dry run/replay remain nonmutating. Shared owner dispatcher remains private; grants are explicit. This resolves historical 0063 node-state mismatch and must be retained in any future dispatcher readability refactor. |

The migration review covers every frozen SQL file, 0000–0086. Current-head
regression proposals are forward migrations plus role-accurate integration
tests. Historical-source readability is never a license to change published
checksums. WQ-204–WQ-211 remain source/test plans, with evidence levels stated
in their owning ledgers; no newly discovered defect is assigned in this group.
