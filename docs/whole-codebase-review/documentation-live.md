# Live documentation, blueprint and operational guidance

All 26 files below were personally read in full. These judgments compare
instructions with the reviewed implementation; no cloud settings, legal
authority, provider accounts, historical performance results or live drills
were requalified. Historical evidence stays dated and immutable. Correcting a
current instruction is not permission to rewrite the result of an earlier run.

| File | Judgment | Specific reading / action |
| --- | --- | --- |
| `docs/workflow-platform-backend-plan.md` | FIX WQ-232 | Authoritative blueprint contains superseded wire examples, synchronous trigger-projection wording and a normative draft directory sketch. Clarify those portions against accepted ADRs, without reopening architecture or changing implementation to an old example. |
| `docs/workflow-platform-backend-research.md` | KEEP | Explicitly supporting, dated research; distinguishes documented behavior from unknown vendor internals and explains why the final coordinator/attempt decision superseded its preliminary whole-run recommendation. Not a new vendor comparison or current procurement recommendation. |
| `docs/codebase-map.md` | KEEP / DOC follow-up | Useful entrypoint → policy → persistence → resource → behavioral-test routes; explicitly rejects empty layers and generic utilities. Add a current-review pointer after completion; retain Q9 as qualified historical evidence, not a claim that later findings cannot exist. |
| `docs/current-implementation-status.md` | DOC follow-up | Clearly keeps production qualification open and separates dated implementation-tree evidence. The current Q9 entrypoint/completeness language needs a dated pointer to this new review and its open findings; do not relabel its historical 21-cohort/477-branch result as newly executed or erase it. |
| `docs/ci-image-update-procedure.md` | KEEP | Digest update coordinates Compose, example environment, CI, scan and real-service tests; local overrides are distinguished from CI pins. No image update or registry verification was performed for this review. |
| `docs/repository-governance.md` | KEEP / DOC follow-up | Explicitly dated single-maintainer zero-approval/signing exception with owner and review trigger. Make it the policy authority linked from the operations runbook; actual present GitHub protection/collaborator state remains externally unverified. |
| `docs/operations/compatibility-retirement-inventory.md` | KEEP | Exact readers, cohorts, removal tests, rollback artifacts, historical checksums and seven NOT VALID exceptions have meaningful individual owners. Zero source consumers or empty Redis is not retirement evidence; no aliases, executors, hashes or constraints may be removed by this audit. |
| `docs/operations/complexity-hotspot-retention.md` | KEEP historical / DOC follow-up | Historical counts are prominently labeled, and focused Q07/Q08 analyses preserve transaction/ledger ownership. Its old SDK `server.ts` “HTTP boundary” description is inaccurate (this is registry composition); annotate rather than invent an HTTP server. Later WQ-193–WQ-199 counterexamples qualify the current completeness wording without negating prior tests. |
| `docs/operations/complexity-refactor-performance.md` | KEEP historical | Fixed revisions, raw rounds, medians, dependency confounder and test-count difference are disclosed. Static `.query(` counts are only supporting source evidence, not per-operation SQL measurements. Do not extrapolate these historical suite timings to current production latency. |
| `docs/operations/credential-boundaries.md` | KEEP | HTTP wire admission and post-decryption runtime validation intentionally have separate trust owners; a named negative/byte-boundary drift suite ties overlapping semantics together. Do not merge browser contracts into server provider code. |
| `docs/operations/database-function-readiness.md` | KEEP | Exact prosrc hashes, security attributes, synchronized forward migration and compatible rollback are operationally meaningful. Keep startup checks distinct from recurrent readiness; a future hash change requires authoritative PostgreSQL evidence and predecessor tests, not text normalization. |
| `docs/operations/dependency-updates.md` | KEEP | Named triage, green-update and deferral review windows; historical “no deferrals” is dated. This review neither updates dependencies nor certifies current advisories. |
| `docs/operations/external-platform-contract.md` | KEEP / DOC follow-up WQ-218 | Detailed E01 selectors, caps, owners, stop/rollback/cleanup and individual approvals remain unresolved and unauthorized. The normalized snapshot validator checks structure/consistency, not authenticated AWS provenance by itself; keep collector/reviewer responsibility explicit and do not claim fabricated JSON is technically impossible. |
| `docs/operations/immutability-policy.md` | KEEP | Ownership-boundary freezing, optional-property absence and private construction values are distinguished. Mutation/profiling gates and rejection of a generic deep-freeze/spread framework match this review's proposed local changes. |
| `docs/operations/local-performance-evidence.md` | KEEP historical / DOC follow-up WQ-228–WQ-230 | Raw-schema history and supersession, operation versus launcher time, function-plan visibility and five-round noise are accurately qualified. Harden source/build identity, positive workload observations and artifact validation before strengthening evidence claims; retain SQL totals as whole-scenario counts including warmup/setup. |
| `docs/operations/local-quality-verification.md` | DOC follow-up WQ-223–WQ-227 | Good isolated-service ownership, serialized coverage and partial-versus-complete semantics. Its unconditional cleanup/source-stability/report-completeness guarantees need the concrete runner/evidence regressions identified in the infrastructure ledgers; a passing historical invocation does not prove every failure path. |
| `docs/operations/observability-alerts.md` | KEEP / linked signal fixes | Each alert has actionable durable-state triage and bounded dimensions; process metrics, client visibility, provider internals and external pager qualification are distinguished. Update a specific signal description only alongside its owning telemetry fix, not via broad runbook rewriting. |
| `docs/operations/persisted-identifiers.md` | KEEP / linked SQL corrections WQ-207/WQ-210 | Correctly distinguishes application UUIDv7 identities from random capability/lease tokens and reviewed atomic SQL-owned UUIDv4 exceptions. The explicit exception is not permission for a SQL producer to violate a downstream strict UUIDv7 reader; preserve the actual producer/consumer finding. |
| `docs/operations/phase-terminology-compatibility.md` | KEEP | Serialized engine IDs, public aliases, exact deployed SQL names and historical prose are deliberately retained. The breaking-release alias milestone is explicit; this audit does not authorize changing durable strings merely to improve naming. |
| `docs/operations/production-data-policy.md` | KEEP | Engineering launch inputs, external legal case authority, separate approver/executor, bounded retention and restore-before-serve are clear. Do not certify operated backup expiry or legal compliance from repository code; no legal policy change is proposed. |
| `docs/operations/regional-recovery.md` | KEEP | Separate deployment-wide writer fence and two stable inventory sweeps; a successful local process is explicitly not RPO/RTO proof. Preserve stop-on-uncertainty and exact-command-only tail repair. |
| `docs/operations/release-security-gate.md` | KEEP / DOC follow-up WQ-218/WQ-231 | Separates repository gates, normalized snapshot and separately approved live drills. Exact image/package exception and scanner semantics are documented, not requalified here. Keep PR gate coverage truthful when the four missing ordinary-PR checks are added. |
| `docs/operations/repository-governance.md` | KEEP / DOC follow-up | Emergency change has explicit incident, scope, expiry, rollback and evidence obligations. Link the dated solo-maintainer exception instead of implying approval settings are established by this runbook; retain external protection evidence requirement. Correct docs-check claims alongside WQ-214. |
| `docs/operations/supported-export-surface.md` | KEEP | Supported package boundaries are not deleted for zero internal consumers; transport request types differ from application inputs. Semantic schema concepts remain distinct without copying rules. Gate behavior corrections belong with the reviewed infrastructure findings. |
| `docs/operations/test-confidence.md` | DOC follow-up WQ-223–WQ-227/WQ-230 | Strong scoped coverage/mutation rationale, but line 50 says lost-COMMIT acknowledgement is not simulated while the later N09 table explicitly records its wire-proxy regression. Clarify historical versus current scope; qualify private-Git isolation, exact evidence freshness and incomplete-artifact rejection using the newly reproduced counterexamples. |
| `docs/operations/test-duplication-review.md` | KEEP historical | Named clone dispositions distinguish shared resource setup from scenario-local assertions and false positives. Historical sums explicitly explain overlap; current executable ceilings own present counts. No directive to reduce duplication by hiding scenario truth. |

## WQ-232 — clarify superseded normative blueprint examples

Priority **P2**; **FIX documentation**; criteria J04/J14. This is a contract
clarification, not an architectural redesign, new ADR or implementation change.

**Exact sites and contradiction.** In
`docs/workflow-platform-backend-plan.md:206`, “should converge on this layout”
introduces a detailed draft hierarchy although the current map deliberately
keeps feature-local ownership without empty web/layer directories. Lines 1041,
1208 and 1990 describe a public `expectedRevision` field or an equivalent to
`If-Match`; ADR 011 and the implemented public contract require the strong opaque
If-Match token, while the internal database CAS legitimately compares numeric
revision. Line 1274 says publication rebuilds trigger projections, and the
endpoint map at 2068 compresses that into the atomic publication operation;
current publication records reconciliation intent while the trigger owner
converges later. Immutable dependency/integration projections are not that
external/runtime trigger reconciliation and must not be conflated.

**Proposed wording shape (not code to implement).**

```text
Public draft save and publish require the strong opaque If-Match contract
defined by ADR 011. Persistence compares the decoded expected revision inside
the authorized transaction; expectedRevision is not an alternative wire field.

Publication atomically stores immutable executable/dependency projections,
updates the publication pointer and records trigger-reconciliation intent.
The trigger owner later converges runtime projections under the current
version/lifecycle fence; publication success is not activation completion.
```

Label the original layout illustrative and point to the existing current
codebase map. Retain valid SQL CAS examples, status-machine detail and original
dated research. Do not silently change accepted ADRs or public requests to make
them agree with an obsolete sketch.

**Acceptance and order.** After the final review index is available, make one
focused documentation change: cross-check every occurrence of
`expectedRevision`, publication/activation and normative layout language
against ADRs 002/011/033/034 and current contracts; add dated follow-up pointers
to current status/map and the live operational claims listed above. Historical
Q/N/audit results keep their original candidate identities and pass counts.
Run the corrected repository-local Markdown/link gate and inspect the diff for
accidental source, policy or migration changes. No PostgreSQL, provider, cloud
or GitHub-setting mutation is needed. Runtime-linked documentation corrections
land with their corresponding fixes, not before those fixes exist.
