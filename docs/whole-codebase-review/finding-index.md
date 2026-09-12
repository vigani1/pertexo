# Complete finding index

Every WQ finding has one primary entry below. Follow the linked area ledger to
the matching WQ section for exact source locations, code examples, evidence
limits, invariants and regression acceptance. Shared extensions remain in their
other area ledgers and are not counted as additional findings. This index is
mechanical navigation, not an extra judgment or proof of implementation.

The structural plan separately owns PF-01–PF-07 and WF-S01. None of these
findings is implemented by this review. Priorities and CONDITIONAL/TEST versus
confirmed FIX classifications belong to each detailed record.

| Finding | Primary detail |
| --- | --- |
| WQ-001 | [prove terminal Redis cleanup after QUIT fails](rate-limit.md) |
| WQ-002 | [reject duplicate definition policies before equality](node-sdk.md) |
| WQ-003 | [inspect and measure the same JSON snapshot](node-sdk.md) |
| WQ-004 | [do not trust thrown values while normalizing inspection failures](node-sdk.md) |
| WQ-005 | [separate registry construction phases and test behaviors](node-sdk.md) |
| WQ-006 | [validate a release once per catalog projection](node-catalog.md) |
| WQ-007 | [align catalog test names, ownership and negative assertions](node-catalog.md) |
| WQ-008 | [bound For Each input before recursive schema traversal](nodes-core.md) |
| WQ-009 | [name bounded code-point counting without changing rule precedence](nodes-core.md) |
| WQ-010 | [retain evaluator ownership until worker termination completes](workflow-model.md) |
| WQ-011 | [make browser and server draft admission limits agree](workflow-model.md) |
| WQ-012 | [protect graph safe parsing from secondary inspection and rereads](workflow-model.md) |
| WQ-013 | [pin own-array lookup and strengthen mapping evidence](workflow-model.md) |
| WQ-014 | [P2: readiness can succeed after close wins](queue.md) |
| WQ-015 | [P2: make error classification unable to change operation outcome](queue.md) |
| WQ-016 | [P2: observe every fallback disconnect rejection](queue.md) |
| WQ-017 | [P2: remove misleading and order-dependent test evidence](queue.md) |
| WQ-018 | [P2: contain unknown-value inspection at logging boundaries](observability.md) |
| WQ-019 | [P1: redaction must survive Nest's shorter truncation boundary](observability.md) |
| WQ-020 | [P2: apply record limits before reading values](observability.md) |
| WQ-021 | [P2: make observability test claims and cleanup precise](observability.md) |
| WQ-022 | [P2: observe the operation even when cancellation already won](artifact-store.md) |
| WQ-023 | [P2: protect classification as well as telemetry callbacks](artifact-store.md) |
| WQ-024 | [P2: compare normalized ledger request material on replay](artifact-store.md) |
| WQ-025 | [P2: compare PUT verification metadata with the requested artifact](artifact-store.md) |
| WQ-026 | [P2: make test ownership and failure cases explicit](artifact-store.md) |
| WQ-027 | [P3 conditional: close stream ownership gaps at coordinator boundaries](artifact-store.md) |
| WQ-028 | [P2: preserve refusal status when Resend's body is malformed](integrations.md) |
| WQ-029 | [P2: make historical dispatch uncertainty a consistent precedence rule](integrations.md) |
| WQ-030 | [P2: ensure error classification cannot strand async work](integrations.md) |
| WQ-031 | [P2: preserve dispatch context for blocked redirect literals](integrations.md) |
| WQ-032 | [P2 TEST/CONDITIONAL: account for late transport responses](integrations.md) |
| WQ-033 | [P2: make crypto temporary ownership and preflight bounds explicit](integrations.md) |
| WQ-034 | [P2: make integration tests diagnostic and policy-sensitive](integrations.md) |
| WQ-035 | [P3: share Slack envelope parsing without merging provider policies](integrations.md) |
| WQ-036 | [P2: keep ordinary URL validation non-throwing](integrations.md) |
| WQ-037 | [P2: distinguish traversal exit frames from cyclic input](workflow-engine.md) |
| WQ-038 | [P2: validate real timestamps and compare instants](workflow-engine.md) |
| WQ-039 | [P2: admit the outer observation array without executing it](workflow-engine.md) |
| WQ-040 | [P2: expose the concepts inside two dense expressions](workflow-engine.md) |
| WQ-041 | [P2: make engine tests explain what they actually prove](workflow-engine.md) |
| WQ-042 | [P2: reject conflicting exact-upstream output descriptors](workflow-engine.md) |
| WQ-043 | [P2: treat an empty iteration path as root scope consistently](workflow-engine.md) |
| WQ-044 | [P2: prevent secondary exceptions while classifying unknown errors](workflow-engine.md) |
| WQ-045 | [P1: reconcile running For Each body attempts before stopping the loop](workflow-engine.md) |
| WQ-046 | [await every started maintenance child before resource cleanup](operational-apps.md) |
| WQ-047 | [require an aborted signal before treating its reason as cancellation](operational-apps.md) |
| WQ-048 | [prove the restore artifact inventory, not only one-item success](operational-apps.md) |
| WQ-049 | [strengthen operational test claims and remove brittle setup](operational-apps.md) |
| WQ-050 | [name operator command translation and centralize only audit fields](operational-apps.md) |
| WQ-051 | [count full Unicode when bounding a connection-test URL](contracts.md) |
| WQ-052 | [bound node-test JSON before recursive schema parsing](contracts.md) |
| WQ-053 | [encode the replay/credential exclusion structurally](contracts.md) |
| WQ-054 | [make contract tests prove one invariant and the real boundary](contracts.md) |
| WQ-055 | [make unknown-error normalization fail closed](api-platform.md) |
| WQ-056 | [keep rate-limit diagnostics outside policy authority](api-platform.md) |
| WQ-057 | [application close must attempt every owned resource](api-platform.md) |
| WQ-058 | [do not report ready after drain began during a health check](api-platform.md) |
| WQ-059 | [make platform tests easier to read and more discriminating](api-platform.md) |
| WQ-060 | [scope Redis fault injection and own partial test startup](api-platform.md) |
| WQ-061 | [preserve authorization failure across artifact verification](api-artifacts-catalog.md) |
| WQ-062 | [artifact fixture ownership and test discrimination](api-artifacts-catalog.md) |
| WQ-063 | [simplify catalog ordering and test its actual contract](api-artifacts-catalog.md) |
| WQ-064 | [tracing must not repeat or replace connection commands](api-connections.md) |
| WQ-065 | [own construction failure and defer every resource close](api-connections.md) |
| WQ-066 | [separate destination transport and reuse context projection](api-connections.md) |
| WQ-067 | [make connection tests discriminate the actual guarantees](api-connections.md) |
| WQ-068 | [authorization proof must satisfy the requested lifecycle policy](api-identity-workspaces.md) |
| WQ-069 | [reconcile callback wire schema without violating OAuth](api-identity-workspaces.md) |
| WQ-070 | [simplify OIDC validation and transaction outcomes](api-identity-workspaces.md) |
| WQ-071 | [explicit encryption parsing and temporary-buffer ownership](api-identity-workspaces.md) |
| WQ-072 | [decide whether the unused API audit facade earns its existence](api-identity-workspaces.md) |
| WQ-073 | [make identity unit tests precise and readable](api-identity-workspaces.md) |
| WQ-074 | [own the real-API fixture and isolate its stories](api-identity-workspaces.md) |
| WQ-075 | [diagnostics must not govern webhook acceptance](api-schedules-webhooks.md) |
| WQ-076 | [make management material and output contracts explicit](api-schedules-webhooks.md) |
| WQ-077 | [strengthen trigger unit evidence at actual interfaces](api-schedules-webhooks.md) |
| WQ-078 | [bound and isolate direct-webhook integration resources](api-schedules-webhooks.md) |
| WQ-079 | [validate selected-node configuration identity](api-node-testing.md) |
| WQ-080 | [resolve exact preview replay before mutable-draft admission](api-node-testing.md) |
| WQ-081 | [precise preview tests and small control-flow cleanup](api-node-testing.md) |
| WQ-082 | [clarify full-tag versus revision-only save authority](api-workflow-authoring.md) |
| WQ-083 | [improve authoring locality and test specificity](api-workflow-authoring.md) |
| WQ-084 | [repair lifecycle fixture ownership without weakening its proofs](api-workflow-authoring.md) |
| WQ-085 | [settle iterator failures without executing rejection values](api-executions-workflow-runs.md) |
| WQ-086 | [do not spin authorization refresh against an unchanged expiry](api-executions-workflow-runs.md) |
| WQ-087 | [own stream acquisition and bound cleanup without hiding live work](api-executions-workflow-runs.md) |
| WQ-088 | [make streaming and rollout fixtures safe on failure](api-executions-workflow-runs.md) |
| WQ-089 | [focused locality and behavioral test completion](api-executions-workflow-runs.md) |
| WQ-090 | [visibility metrics must not terminate event delivery](api-executions-workflow-runs.md) |
| WQ-091 | [forward workspace transaction options through Nest adapter](worker-platform.md) |
| WQ-092 | [diagnostics cannot prevent readiness revocation or drain signaling](worker-platform.md) |
| WQ-093 | [bound readiness lifetime and revoke before waiting on stalled checks](worker-platform.md) |
| WQ-094 | [reject resource-sampling delays that overflow Node timers](worker-platform.md) |
| WQ-095 | [improve platform test truth and focused readability](worker-platform.md) |
| WQ-096 | [transport provider acquisition and dependency-safe close](worker-transport.md) |
| WQ-097 | [dispatcher lifecycle must own every operation it starts](worker-transport.md) |
| WQ-098 | [bound actual capacity-sampling work, not only its await](worker-transport.md) |
| WQ-099 | [simplify activation reading and make transport tests contractual](worker-transport.md) |
| WQ-100 | [contain the entire provider diagnostics lifecycle](worker-telemetry.md) |
| WQ-101 | [strengthen telemetry evidence without flattening useful policy](worker-telemetry.md) |
| WQ-102 | [complete coordinator/trigger runtime ownership and supervision](worker-coordinator-triggers.md) |
| WQ-103 | [targeted readability, compatibility and fixture corrections](worker-coordinator-triggers.md) |
| WQ-104 | [distinguish a delivery deadline from a cancellation request](worker-maintenance-notifications.md) |
| WQ-105 | [preserve provider policy while making tests and branches legible](worker-maintenance-notifications.md) |
| WQ-106 | [protect heartbeat acquisition and finish runtime ownership](worker-node-execution.md) |
| WQ-107 | [reserve the per-attempt dispatch marker before awaiting](worker-node-execution.md) |
| WQ-108 | [close artifact streams and clear every owned chunk](worker-node-execution.md) |
| WQ-109 | [stop connection work at cancellation boundaries](worker-node-execution.md) |
| WQ-110 | [readability and test plan for production attempts](worker-node-execution.md) |
| WQ-111 | [forward preview connection authority and provider binding](worker-preview-execution.md) |
| WQ-112 | [supervise actual preview work, not just the winning promise](worker-preview-execution.md) |
| WQ-113 | [preview test fidelity and localized simplification](worker-preview-execution.md) |
| WQ-114 | [make the service recovery deadline an actual admission boundary](worker-transport-integration.md) |
| WQ-115 | [own and isolate integration resources through failed teardown](worker-transport-integration.md) |
| WQ-116 | [make proof names and assertions match what was exercised](worker-transport-integration.md) |
| WQ-117 | [prove handler redelivery separately from queue deduplication](worker-coordinator-integration.md) |
| WQ-118 | [make recovery test ownership survive failure and process exit](worker-coordinator-integration.md) |
| WQ-119 | [concentrate fixture mechanics without hiding domain assertions](worker-coordinator-integration.md) |
| WQ-120 | [own each child-evidence wait through every settlement path](worker-preview-integration.md) |
| WQ-121 | [preserve private fixture resources and cleanup ordering](worker-preview-integration.md) |
| WQ-122 | [make preview scenario evidence independent and precise](worker-preview-integration.md) |
| WQ-123 | [keep integration consumers and cleanup inside private ownership](worker-lifecycle-artifact-integration.md) |
| WQ-124 | [state exactly what each integration scenario proves](worker-lifecycle-artifact-integration.md) |
| WQ-125 | [release the benchmark scan gate before runtime drain](worker-schedule-integration.md) |
| WQ-126 | [separate schedule fixture mechanics from scenario evidence](worker-schedule-integration.md) |
| WQ-127 | [own the entire provider proof lifecycle](worker-http-integration.md) |
| WQ-128 | [expose provider scenarios and keep proof claims exact](worker-http-integration.md) |
| WQ-129 | [classify pool diagnostics inside the nonthrowing boundary](database-foundation.md) |
| WQ-130 | [release a shared lock sampler at most once per pool owner](database-foundation.md) |
| WQ-131 | [tighten foundation evidence and local readability](database-foundation.md) |
| WQ-132 | [make startup drift checks match the claimed invariant](database-readiness.md) |
| WQ-133 | [isolate destructive readiness fixtures and unblock teardown](database-readiness.md) |
| WQ-134 | [make readiness code and evidence navigable without weakening it](database-readiness.md) |
| WQ-135 | [preserve migration failures and make runner time bounds explicit](database-migration-runner.md) |
| WQ-136 | [qualify future nontransactional modes before relying on declarations](database-migration-runner.md) |
| WQ-137 | [keep migration history evidence precise and fixtures owned](database-migration-runner.md) |
| WQ-138 | [make package-contract tests genuinely offline and test the build](database-schema-surfaces.md) |
| WQ-139 | [align schema inventories and narrow or strengthen catalog claims](database-schema-surfaces.md) |
| WQ-140 | [use the existing cancellation-aware owner for session lookup](database-tenant-access.md) |
| WQ-141 | [validate finite dates and bounded metadata before work](database-tenant-access.md) |
| WQ-142 | [localize identity persistence responsibilities and result states](database-tenant-access.md) |
| WQ-143 | [isolate identity integration fixtures and sharpen assertions](database-tenant-access.md) |
| WQ-144 | [qualify authority and credential ordering at dispatch admission](database-connections.md) |
| WQ-145 | [simplify repeated connection knowledge without flattening states](database-connections.md) |
| WQ-146 | [pay for historical database fixtures only where they are needed](database-connections.md) |
| WQ-147 | [bound publication's retained-history working set without weakening validation](database-authoring.md) |
| WQ-148 | [localize compatibility normalization and clarify trusted data contracts](database-authoring.md) |
| WQ-149 | [make authoring integration fixtures safe and rollback claims meaningful](database-authoring.md) |
| WQ-150 | [discard the compatibility-maintenance client when rollback fails](database-compatibility.md) |
| WQ-151 | [preserve diagnostic cause without changing fail-closed release checks](database-compatibility.md) |
| WQ-152 | [specify and test database-versus-engine checkpoint validation coverage](database-compatibility.md) |
| WQ-153 | [make release rollout evidence independent and cleanup accountable](database-compatibility.md) |
| WQ-154 | [make reconciliation authority and materialized disposition legible](database-workflow-webhook-triggers.md) |
| WQ-155 | [specify graph-disabled trigger behavior before modifying projection](database-workflow-webhook-triggers.md) |
| WQ-156 | [give webhook replay one lock/read/expiry decision](database-workflow-webhook-triggers.md) |
| WQ-157 | [validate compatibility before acquiring the webhook pool](database-workflow-webhook-triggers.md) |
| WQ-158 | [make trigger evidence independent and time-authority aware](database-workflow-webhook-triggers.md) |
| WQ-159 | [own cancellation and all claimed schedule work](database-schedules.md) |
| WQ-160 | [expose schedule command phases and coherent health policy](database-schedules.md) |
| WQ-161 | [optimize recurrence only within a proven semantic envelope](database-schedules.md) |
| WQ-162 | [make schedule integration evidence focused and deterministic](database-schedules.md) |
| WQ-163 | [strengthen persistence-boundary evidence without replacing safe code](database-execution-values-readers.md) |
| WQ-164 | [bound admission-error inspection and preserve the original failure](database-run-admission-events.md) |
| WQ-165 | [specify snapshot consistency for run reads and event-page metadata](database-run-admission-events.md) |
| WQ-166 | [name replay-validation modes and notification pin eligibility](database-run-admission-events.md) |
| WQ-167 | [isolate destructive fixtures and complete run behavior evidence](database-run-admission-events.md) |
| WQ-168 | [bound transport JSON before recursive processing](database-transport.md) |
| WQ-169 | [complete result validation before committing dispatcher claims](database-transport.md) |
| WQ-170 | [make transport proof ownership and failure assertions explicit](database-transport.md) |
| WQ-171 | [make operator cancellation and pool shutdown truthful](database-operator.md) |
| WQ-172 | [validate bounded operator JSON without silent evidence rewriting](database-operator.md) |
| WQ-173 | [strengthen command/replay proof without flattening authority](database-operator.md) |
| WQ-174 | [never let unlock-error inspection bypass client disposal](database-artifacts.md) |
| WQ-175 | [propagate finalization cancellation through short database phases](database-artifacts.md) |
| WQ-176 | [clarify artifact phases while retaining two-phase revalidation](database-artifacts.md) |
| WQ-177 | [complete artifact boundary, ownership and concurrency evidence](database-artifacts.md) |
| WQ-178 | [validate completion timing and attempt controls at the database seam](database-notifications.md) |
| WQ-179 | [correct audit target identity and clarify destination command phases](database-notifications.md) |
| WQ-180 | [strengthen notification evidence at the real boundaries](database-notifications.md) |
| WQ-181 | [remove row locks from the read-only observation snapshot](database-coordinator.md) |
| WQ-182 | [an optional metric must not hold an acknowledged commit indefinitely](database-coordinator.md) |
| WQ-183 | [reduce local lookup and control-flow burden without weakening policy](database-coordinator.md) |
| WQ-184 | [distinguish canonical protocol limits from wire/materialization limits](database-coordinator.md) |
| WQ-185 | [make coordinator tests independent, owned and faithful to their titles](database-coordinator.md) |
| WQ-186 | [make outcome projection explicit without fragmenting transactions](database-node-attempts.md) |
| WQ-187 | [isolate attempt tests and make replay/ownership assertions exact](database-node-attempts.md) |
| WQ-188 | [use one bounded output contract, with a total validation result](database-preview.md) |
| WQ-189 | [a terminal preview duplicate must match its durable identity and value](database-preview.md) |
| WQ-190 | [specify and verify expiry versus fencing for preview ownership](database-preview.md) |
| WQ-191 | [persist the canonical JSON envelope once, retaining read compatibility](database-preview.md) |
| WQ-192 | [keep preview tests independent and trim concrete readability costs](database-preview.md) |
| WQ-193 | [preserve external-ledger freshness across destructive authorization](database-retention.md) |
| WQ-194 | [make maintenance SQL cancellation real and owned](database-retention.md) |
| WQ-195 | [cleanup failure state must not reuse a contaminated client](database-control-ledger.md) |
| WQ-196 | [simplify the control command phases, keeping bounded recovery visible](database-control-ledger.md) |
| WQ-197 | [make retention outcomes and cleanup evidence honest](database-retention.md) |
| WQ-198 | [own lifecycle transaction failure and name its durable phases](database-workspace-lifecycle.md) |
| WQ-199 | [separate purge phases without hiding destructive authorization](database-workspace-lifecycle.md) |
| WQ-200 | [make integration evidence and teardown match their claims](database-crosscutting-tests.md) |
| WQ-201 | [prevent adaptive benchmark setup from masking regressions](database-crosscutting-tests.md) |
| WQ-202 | [preserve retention assertions while isolating state and race evidence](database-retention-integration.md) |
| WQ-203 | [retain historical smoke tests, strengthen semantic evidence](database-static-migration-tests.md) |
| WQ-204 | [prove populated historical vocabulary upgrades under real owner RLS](database-migrations-foundation.md) |
| WQ-205 | [test OIDC capacity lock-time freshness before optimizing it](database-migrations-foundation.md) |
| WQ-206 | [make SQL shape predicates total, not merely visually exhaustive](database-migrations-execution.md) |
| WQ-207 | [align notification connection UUIDs with the persisted-ID contract](database-migrations-execution.md) |
| WQ-208 | [make privileged recovery page bounds reject NULL explicitly](database-migrations-execution.md) |
| WQ-209 | [reject NULL lease credentials before privileged lifecycle mutation](database-migrations-retention.md) |
| WQ-210 | [include UUIDv7 in execution-artifact reference locking](database-migrations-retention.md) |
| WQ-211 | [make workspace tenant purge obey its own pointer/FK contracts](database-migrations-operations.md) |
| WQ-212 | [dispose test-owned temporary repositories/directories](infrastructure-gates.md) |
| WQ-213 | [bound local gate subprocess completion](infrastructure-gates.md) |
| WQ-214 | [resolve fragment-only links against the current document](infrastructure-gates.md) |
| WQ-215 | [make complexity observations uniquely addressable](infrastructure-gates.md) |
| WQ-216 | [validate machine evidence before aggregating it](infrastructure-gates.md) |
| WQ-217 | [test deployment constraints, not substrings or list length](infrastructure-deployment.md) |
| WQ-218 | [make external evidence coverage match the claimed policy](infrastructure-deployment.md) |
| WQ-219 | [give startup smoke explicit acquisition and readiness ownership](infrastructure-deployment.md) |
| WQ-220 | [reserve an evidence destination before launching side effects](infrastructure-operations.md) |
| WQ-221 | [separate exercise scheduling, outcomes and evidence arithmetic](infrastructure-operations.md) |
| WQ-222 | [qualify metric aggregation and alert meaning across writers](infrastructure-operations.md) |
| WQ-223 | [isolate explicit snapshot Git commands from hook metadata](infrastructure-quality-runner.md) |
| WQ-224 | [derive qualification requirements from trusted cohort definitions](infrastructure-quality-runner.md) |
| WQ-225 | [close remaining runner acquisition and output-lifecycle gaps](infrastructure-quality-runner.md) |
| WQ-226 | [fingerprint exact reviewed source semantics](infrastructure-coverage-evidence.md) |
| WQ-227 | [keep evidence generation honest about source and execution](infrastructure-coverage-evidence.md) |
| WQ-228 | [Bind benchmark evidence to the measured source and measurement scope](infrastructure-performance.md) |
| WQ-229 | [Observe rejection immediately and close every acquired benchmark resource](infrastructure-performance.md) |
| WQ-230 | [Align accepted manifests and evidence with what the runner can prove](infrastructure-performance.md) |
| WQ-231 | [Keep required local invariants in ordinary PR CI](root-and-ci.md) |
| WQ-232 | [clarify superseded normative blueprint examples](documentation-live.md) |
