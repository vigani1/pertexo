# Architecture decision records

All 35 ADRs were personally read in full and compared with their current
implementation owners and the reviewed regression obligations. These are
accepted contracts and dated decision evidence, not proof that every current
runtime path satisfies them. Keep historical measurements tied to their
recorded revision. No new ADR or architectural decision is authorized by this
review; routine corrections should clarify supersession without rewriting
history or changing durable semantics.

| File | Judgment | Specific reading / change constraint |
| --- | --- | --- |
| `docs/adr/001-modular-monolith-monorepo-api-worker.md` | KEEP | Process separation and capability ownership are clear. The explicit September clarification already prevents the original web-app description from requiring an empty workspace. Later dedicated roles have their own decisions. |
| `docs/adr/002-postgresql-jsonb-drafts-immutable-versions-checksum-identity.md` | KEEP | Coherent graph authority, executable identity, idempotency-before-stale-check and lock order are distinct invariants. Phase-2-only inactive/trigger statements remain historical; ADRs 010/033/034 graduate those portions. Do not copy early-phase limits into current serving policy. |
| `docs/adr/003-workspace-tenancy-rls-runtime-roles.md` | KEEP | Explicit workspace transaction/RLS/role separation remains binding. The simple missing-GUC example is not a substitute for the implemented empty-setting-safe policy and readiness checks. Its dated 31-assertion result is history, not today's total. |
| `docs/adr/004-managed-oidc-and-internal-authorization.md` | KEEP | Provider identity does not grant membership; session/CSRF and independent SSE authorization deadlines are explicit. Preserve offline versus provider authority and the September SSE amendment. Later async lifecycle acceptance is governed by ADR 027. |
| `docs/adr/005-postgresql-authority-bullmq-outbox-engine-gate.md` | KEEP | Durable authority, transport redelivery, inbox identity and unknown-effect policy explain real complexity. Legacy spike commands are explicitly historical and point to current recovery gates; no reason to reintroduce retired surfaces. |
| `docs/adr/006-coordinator-checkpoint-and-node-attempt-jobs.md` | KEEP | Small, deep separation of pure planning from provider work and short CAS commits. Its provisional gate language refers to the original Phase-0E sequence, resolved by ADR 005's dated GO evidence. |
| `docs/adr/007-run-node-state-retry-idempotency.md` | KEEP | Separate state machines, side-effect classes, stable logical keys and truthful cancellation must survive all readability refactors. Never shorten precedence into generic failed/canceled flags. |
| `docs/adr/008-structured-bounded-loops.md` | KEEP | Deterministic scopes, full ledgers and all-settled canonical join selection justify many scheduler branches. Later node ADRs refine representation, not permission for arbitrary cycles or race-selected joins. |
| `docs/adr/009-restricted-jsonata.md` | KEEP | Explicit language allowlist, input/output limits, worker hard stop and missing-value result; no claim worker threads are an OS security sandbox. Preserve policy-version compatibility and exact limit semantics. |
| `docs/adr/010-node-executor-compatibility-retirement.md` | KEEP | Definition/executor/policy identity, selected versus whole-release fingerprint and blocked-before-removal protocol are durable contracts. Historical V1 readability is not new-run eligibility. No old executor removal without inventory proof. |
| `docs/adr/011-optimistic-draft-concurrency.md` | KEEP | Strong opaque If-Match and database revision are different representations; exact command replay precedes current-state comparison. Version restoration amendment is a draft edit, not publication or lifecycle restore. |
| `docs/adr/012-fair-admission-backpressure-entitlements.md` | KEEP | Separates PostgreSQL capacity from Redis short-window abuse dimensions and maps fail-open reads versus fail-closed writes. Generic webhook hard rejection is not a pending accepted delivery. |
| `docs/adr/013-retention-workspace-deletion-legal-hold.md` | KEEP | Destructive lock order, external high-water check, dual authority projection and explicit retention/replay windows are essential. Keep legal/backup policy inputs distinct from engineering assertions and avoid strengthening deletion claims without runtime evidence. |
| `docs/adr/014-schedule-timezone-dst-misfire.md` | KEEP | Bounded recurrence, database-time occurrence identity, earlier ambiguous instant and adjusted gap behavior are deliberate. Do not substitute current parser defaults or enumerate an unbounded missed backlog. |
| `docs/adr/015-production-slo-region-and-recovery.md` | KEEP | Explicit EU topology, writer fence, dual-ledger/object proof and separate SLI/latency objectives. Launch drills remain open; local tests cannot prove regional RPO/RTO or IAM. |
| `docs/adr/016-node-preview-testing-semantics.md` | KEEP | Offline validation versus acknowledged real test execution, independent execution/retention deadlines and single-attempt preview identity are clear. Preview remains separate from production checkpoint state. |
| `docs/adr/017-condition-branch-selection.md` | KEEP | Strict boolean selection, persisted output authority and explicit skips; later Merge graduation does not invalidate original pre-Merge rejection. Keep checkpoint V1/V2 compatibility. |
| `docs/adr/018-switch-ordered-case-selection.md` | KEEP | Stored case order controls precedence; stable case IDs control branch identity. Scalar-only exact comparison avoids coercion/expression drift. |
| `docs/adr/019-bounded-parallel-and-merge.md` | KEEP | Paired topology, admission capacity and full terminal ledger distinguish fan-out from branch selection. Any/count are deterministic, not first-completion races. |
| `docs/adr/020-bounded-for-each.md` | KEEP | Full collection reservation, ordinal scope, nearest structured input and completion barrier prevent partial-limit execution and accidental aggregation. Preserve parent output rather than inventing collected body results. |
| `docs/adr/021-durable-wait.md` | KEEP | Node wait versus retry, resumed immutable attempt and independent run-deadline wakeup are explicit. No sleeping worker or rearming duration on resume. |
| `docs/adr/022-run-failure-notification.md` | KEEP | Terminal truth and delivery truth remain separate. Safe primary failure ordering and R0/R1/R2 context rollout are precise; local dual-reader tests are not fleet activation evidence. |
| `docs/adr/023-slack-send-message-provider.md` | KEEP | Fixed-origin bounded text action, secret fence and conservative unsafe ambiguity. Reverify provider contracts on authorized changes; do not infer Slack idempotency from a parameter name. |
| `docs/adr/024-resend-email-notification-provider.md` | KEEP / TEST | Provider-specific 24-hour idempotency scope must include actual dispatch/recovery lifetime, not merely nominal retry delays. Preserve same payload/account/key and follow the source audit's retry-horizon findings; no silent provider substitution. |
| `docs/adr/025-provider-failure-notification-destinations.md` | KEEP | Immutable destination versions, disable-before-dispatch serialization and pinned credential/payload identity are meaningful separate fences. Never replace with mutable latest configuration. |
| `docs/adr/026-generic-webhook-signature-replay.md` | KEEP | Raw-byte authentication/deduplication, one-time disclosure and independent key/secret rotation are intentionally different from semantic graph JSON. Preserve management authorization and pre-KMS ingress bound. |
| `docs/adr/027-workspace-lifecycle-command-dispatch.md` | KEEP | API durable intent is not completed access revocation. Dedicated command role and exact retry identity preserve least privilege across the external append window. |
| `docs/adr/028-ecs-deployment-manifest.md` | FIX / KEEP | Process-role/secret/migration decisions remain valid. WQ-218/WQ-219 require correcting its current-evidence wording: normalized JSON does not authenticate AWS collection, and current non-HTTP roles use readiness markers rather than only process health. Link the accepted current contract without inventing a new deployment model. |
| `docs/adr/029-operator-command-execution-boundary.md` | KEEP | One-shot operator authority, command-specific functions, durable replay and separate control-plane invocation audit are clear. Repo tests do not prove a production actor's IAM authorization. |
| `docs/adr/030-autoscaling-input-contract.md` | KEEP | Correctly labels inputs, raw counts, normalized utilization and external scaling evidence. Do not relabel handler count as utilization or assume task-definition rendering provisions policies. |
| `docs/adr/031-authenticated-user-run-replay.md` | KEEP | Explicit input/version/source, dedicated replay capability, new run identity and unchanged source history. No operator privilege proxy or implicit latest/input copy. |
| `docs/adr/032-validate-node-semantics.md` | KEEP | Bounded ordered field rules, one issue per rule, fixed diagnostics and successful `valid:false` output distinguish data mismatch from executor failure. Preserve Unicode and truncation meaning. |
| `docs/adr/033-truthful-workflow-activation-projection.md` | KEEP | Narrow supersession of Phase-2 response vocabulary, not lifecycle or publication policy; unknown stored state fails rather than becoming inactive. |
| `docs/adr/034-workflow-archive-restore-and-activation.md` | KEEP | Independent lifecycle revision, immediate admission denial and later trigger convergence. Preserve disabled configuration, current-version authority and existing run history under races. |
| `docs/adr/035-public-artifact-upload-and-capacity.md` | KEEP | Direct immutable upload, bounded bearer URL trade-off, reauthorized finalization, advisory lock and charged-until-deleted capacity are one coherent vertical contract. Explicit 30-day finalized-user-upload amendment matches the final migration. |

The authoritative plan's old illustrative draft fields and synchronous trigger
projection wording require a consolidated documentation correction after its
remaining sections are checked. This does not authorize changing the implemented
strong-ETag, asynchronous reconciliation or immutable-version contracts to match
an older example.
