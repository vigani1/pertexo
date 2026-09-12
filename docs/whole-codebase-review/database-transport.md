# Database transport and duplicate-proof fixtures

Date: 2026-09-12. Primary reviewer fully read these 12 files. Five existing unit
tests passed (381 ms); the empty-allowlist test constructed a monitored runtime
pointing at an unreachable local port, so this is not evidence of zero network
attempts. Separate source probes made no connection. Integration tests and SQL
fixture were inspected, not executed or applied.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `packages/database/src/execution/dispatcher.ts` | KEEP authority/fairness; TEST/FIX WQ-169; WQ-132/WQ-150 extensions | Explicit durable cursor, capacity admission, exhaustion and token fencing are necessary. Validate claimed results before committing; failed rollback must not release a reusable client. Readiness checks incompletely express required mutable grants and policy/index shape. |
| `packages/database/src/execution/dispatcher-contracts.ts` | KEEP | Transport identity, lease and attempt fields form a useful dependency-light projection; do not merge it merely because it is small. |
| `packages/database/src/execution/dispatcher-rows.ts` | KEEP; TEST WQ-169 | Strict database projection plus one snake/camel mapper is cohesive. Retain date conversion and explicit counter validation; projection rejection belongs inside the transaction. |
| `packages/database/src/execution/outbox.ts` | FIX/TEST WQ-168 | Transaction-derived workspace and immutable identity/checksum checks are appropriate. Recursive JSON validation and canonicalization precede the payload bound. |
| `packages/database/src/execution/inbox.ts` | KEEP; TEST WQ-170 | Receipt, business work and completion share a transaction; invisible cross-tenant conflict fails closed. Checksum mismatch deliberately aborts work then records a separate durable security fact. Do not merge those transactions. |
| `packages/database/test/transport.test.ts` | KEEP assertions; TEST/FIX WQ-170 | Tests byte cap, malformed/mismatched hash and key ordering. Eager background monitoring undermines a no-query reading of the empty-allowlist case; teardown is not in finally. |
| `packages/database/test/transport.integration.test.ts` | KEEP behavioral proofs; fixture FIX/TEST WQ-170 | Real commit/rollback/lost-ACK controls, immutable grant denial, exhaustion, fair restart and exact operator replay are valuable. Acquisition gaps, shared reset and an unbounded ACK barrier need repair. Forced-index EXPLAIN is eligibility evidence, not a latency benchmark. |
| `packages/database/test/transport-part-2.integration.test.ts` | KEEP; fixture FIX/TEST WQ-170 | Real inbox dedupe suppresses business and provider callbacks, proves mismatch audit and tenant hiding. Rollback test should assert the business row is absent, not only receipt retry. A single-workspace positive count does not prove the title's exclusivity. |
| `packages/database/test/support/transport.integration.support.ts` | fixture FIX WQ-170 | Role-separated handles and checksums are useful; construction starts resources at import, reset truncates shared durable state, and connect occurs before cleanup protection. Cause traversal should use bounded test inspection. |
| `packages/database/test/support/postgres-commit-ack-proxy.ts` | KEEP narrow fault concept; fixture FIX/TEST WQ-170 | Suppresses response until ReadyForQuery to model an uncertain COMMIT. Armed promise has no close/failure settlement; protocol assumptions and peer socket lifetime need explicit tests and bounds. |
| `packages/database/test/support/q11-benchmark.ts` | KEEP; conditional TEST WQ-170 | Opt-in operation intervals, role/database identity and file barrier are clear. Exclusive participant marker and deadline prevent silent overlap reuse; preserve parent-owned directory lifecycle and distinguish batch elapsed time from per-operation percentiles. |
| `packages/database/test/fixtures/queue-duplicate-proof.sql` | KEEP test-only model; fixture isolation WQ-170 | Explicit uniqueness, completion constraints and RLS support a bounded proof without production tables. Historical test-volume backfill is intentionally test-only. This broad test-role grant set is not a production authorization model. |

## WQ-168 — bound transport JSON before recursive processing

P2 FIX/TEST. outbox.ts:10–16 applies z.json() before the 4096-byte refinement;
canonicalOutboxPayloadChecksum at 51–54 also validates recursively and then
recursively serializes. Source probes using 5,000 nested objects produced
RangeError in both checksum and insertion paths before any transaction access.
An enumerable getter was invoked during checksum input handling. Current callers
mostly construct small internal job facts; no reachable remote denial of service
or production incident is established by these probes.

Use bounded, stack-safe JSON inspection/copy before hashing or persistence, reusing
an existing compatible internal mechanism only where its contract fits. Preserve
the exact canonical byte/hash contract: UTF-16 lexical object-key ordering,
array order, null, finite numbers including -0, Unicode handling and repeated
acyclic references. Do not silently introduce a new canonicalization standard,
change historical queue checksums or reject existing valid payloads without an
explicit compatibility decision. Check the current compact application byte cap
and PostgreSQL JSONB text backstop separately; they are not identical encodings.

Tests: deep/cyclic/oversized structures, byte-boundary multibyte payloads,
getter/proxy/toJSON policy, repeated references, reordered keys, array order,
primitive roots, malformed checksum and correctly formatted mismatched checksum.
Require controlled rejection before transaction access and unchanged golden
hashes for all supported valid inputs. Avoid computing unrelated large payloads
merely to discover the 4 KiB limit afterward. Keep the error contract explicit.

## WQ-169 — complete result validation before committing dispatcher claims

P2 TEST/FIX. dispatcher.ts:362–369 commits before claimQueryResultSchema.parse
and projection mapping. If a returned row fails validation, leases/exhaustion/
cursor changes have committed, but the caller receives no claim result; catch
then sends ROLLBACK after COMMIT. This is source-evidenced failure ordering under
malformed returned data, not proof ordinary constrained rows currently violate
the decoder. Validate/map/freeze the result before COMMIT and return it only
after acknowledgement. A lost COMMIT acknowledgement must still be reported as
uncertain failure, not converted to success from a precomputed object.

Add injected query tests for malformed/missing aggregate rows, invalid event
fields, mapping failure, query failure, commit rejection and rollback rejection.
Assert order, no successful commit on decoder failure, preserved original cause,
and poisoned-client disposal (WQ-150). Use the existing runtime seam, not a new
generic transaction framework. Retain a real uncertain-commit integration case.

Readability: keep the ordered CTEs and comments explaining durable workspace
rotation and capacity authority. Extract a named private SQL constant only if it
makes transaction ownership easier to read; do not decompose the atomic SQL into
separate queries. The final three-outcome release ternary is comprehensible;
rewriting it is optional polish, not a defect. The repeated job allowlist schema
can be one private schema without exporting another public abstraction.

WQ-132 extension: checkDispatcherReadiness accepts any UPDATE column privilege,
not every required lifecycle column. Policy count verifies names/role membership,
not command/expressions or conflicting extra policies; pg_indexes substring
matching does not establish index validity. Qualify each claimed invariant with
isolated revoked-column, altered-policy and invalid/wrong-index drift tests before
strengthening catalog checks. Keep exact migration head, least privilege and
capacity-function checks. Measure backlog COUNT/fair cursor contention before
proposing cached counts, estimates or a fairness rewrite.

## WQ-170 — make transport proof ownership and failure assertions explicit

P2 fixture FIX/TEST. transport.integration.support.ts:120–160 truncates shared
outbox/inbox/audit/operator/admission tables. Random workspace IDs do not scope
TRUNCATE. Own a disposable database before applying the SQL fixture or resetting
state; Q11 shared-database mode needs an explicitly coordinated isolated benchmark
environment, not permission to clear an arbitrary configured service. Construct
handles under protected setup and guard a pool before awaiting connect. Attempt
all owned cleanup, including replica/monitor resources, on partial setup failure.

In transport.test.ts inject a monitor-disabled runtime and query sentinel to
prove empty allowlist/invalid duplicate input performs zero business queries;
put close in finally. Add inbox callback rejection, incomplete receipt, aborted
mismatch-audit and audit-failure cases without weakening the separate-transaction
security fact. Strengthen rollback to inspect absence of the business mutation,
and workspace-completion to inspect both workspaces and exact receipt identity.
Retain durable provider-intent proof without claiming a real external provider
effect occurred in this database-only test.

The lost-ACK test at transport.integration.test.ts:180–311 creates the proxy and
database before its protected block, then awaits acknowledgementDropped before
observing uncertain. If the operation rejects before reaching COMMIT, the barrier
never settles and the operation can remain an unobserved rejection. Observe work
immediately, use a bounded fault milestone that also fails when work ends early,
and settle/cancel every waiter on shutdown. Protect the proxy before constructing
the database and attempt both closes even if the first rejects. Protect the first
fairness-restart process before claim too (current close follows successful claim).

The proxy parses startup then simple-query COMMIT and waits for backend Z; it is
not a general PostgreSQL/TLS proxy. Explicitly reject or support TLS negotiation,
fragmented/coalesced protocol frames, malformed lengths and unsupported query
forms. Bound buffering and handle parser errors inside socket ownership. Normal
close currently only removes its own socket from the set, while error handlers
destroy the peer; add tests for early normal disconnect in both directions and
ensure no peer stays open. Closing must stop admission before draining sockets,
settle an armed drop waiter, and remain idempotent. These are source-level fixture
risks; no live PostgreSQL fault run was performed for this review.

Q11 helper tests should cover partial/invalid config, existing participant marker,
missing/released barrier, non-ENOENT access error, timeout, role identity failure
and pool close. Prefer an injectable clock/filesystem seam only if needed for fast
tests; don't weaken the benchmark's real overlap/role evidence. Keep emitted timing
as batch elapsed time with population, not invented p95 statistics.

Implementation order: disposable fixture ownership and observed fault barriers;
WQ-168/169 regression fixes; isolated readiness drift tests; private readability
cleanup. All production source, tests and migration SQL remain unchanged here.
