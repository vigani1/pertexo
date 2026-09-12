# Database execution values and published projection reader

Date: 2026-09-12. Primary reviewer fully read all five files below; hashes match
the inventory. Both unit files passed, 23 tests (113 ms). The database integration
suite was inspected only; no shared-schema drift was applied.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `packages/database/src/execution/stored-execution-value.ts` | KEEP; TEST WQ-163 | Iterative descriptor-safe clone and separate iterative canonical serialization are justified. Explicit PostgreSQL Unicode constraints, per-value byte bound and larger JSONB backstop have different roles. Active-path cycle detection deliberately permits noncyclic aliases. |
| `packages/database/src/execution/published-workflow-reader.ts` | KEEP; FIX WQ-157 extension; TEST WQ-163 | Distinguishes not-found, retained non-executable V1 and shallow V2 storage projection; the worker verifies executable semantics later. Signal reaches the real transaction owner. Compatibility parsing follows pool acquisition and must move before it. |
| `packages/database/test/stored-execution-value.test.ts` | KEEP; TEST WQ-163 | Exact byte/depth/member limits, PostgreSQL Unicode, aliases, getter avoidance and inherited toJSON hooks are valuable direct contract evidence. Some stronger titles are not fully established by their assertions. |
| `packages/database/test/published-workflow-reader.test.ts` | KEEP; TEST WQ-163 | Accurately named historical migration contract tests protect column grants. Despite the filename, they do not exercise the exported row classifier or reader lifecycle. |
| `packages/database/test/published-workflow-reader.integration.test.ts` | KEEP; fixture FIX WQ-134 extension; TEST WQ-163 | Real column denial, tenant filtering, immutable rows and drift detection are valuable. Uses the configured shared database, alters live constraints/policies/grants and restores assumed definitions under an advisory lock not observed by every client. Requires an owned isolated database. |

## WQ-163 — strengthen persistence-boundary evidence without replacing safe code

P2 TEST. The stored-value implementation is a good example of complexity that
earns its place. Do not replace it with JSON.stringify on the original value,
recursive z.json(), or a generic cross-package validator that erases the different
alias, Unicode and envelope contracts. The source has separate admission and
canonicalization phases, finite traversal, stable key sorting, normalized -0,
fresh null-prototype objects and own-data assignment for prototype-shaped keys.

In stored-execution-value.test.ts:73–103 the deep-copy/deep-freeze test checks
only the envelope and root object are frozen. Assert distinct nested object and
array identities, nested frozen state, and unchanged normalized value after
mutating the original. At 169–209, oversized container rejection does not prove
the title's before-bulk-reflection claim. Either narrow the title or add safely
restored instrumentation proving early failure before full own-name reflection.
Do not infer performance from rejection alone.

Add exact encoded-byte cases for escaped control characters and multibyte keys/
values, an independent Buffer.byteLength oracle on admitted canonical output,
the 4 MiB serialized-input backstop, exponent expansion round-trip distinction,
own __proto__ data, symbol/non-enumerable fields and revoked proxies. Preserve
the existing hostile-hook test's unconditional prototype restoration. Property
cases should be seeded/bounded and compare against an independent limited JSON
oracle, not invoke the subject serializer to compute its own expected result.

Add direct classifyPublishedWorkflowVersionRow tests for undefined, valid V1,
valid V2, partial envelope columns, malformed checksum, array/null executable,
invalid epoch and unexpected projected columns. The classifier intentionally
does not validate the entire executable envelope; test that downstream worker
verification rejects corrupt semantic content rather than silently broadening
this reader into a compiler. Keep current serving-release expectation distinct
from a retained workflow's admitted release epoch.

WQ-157 applies at published-workflow-reader.ts:160–166: validate compatibility
input before owned pool creation; constructor rejection creates no monitor, and
borrowed runtimes remain caller-owned. Test pre-aborted read performs no checkout,
signal forwarding reaches the actual cancellation-aware owner, and close retains
owned-versus-borrowed behavior. Avoid inventing a fake pg signal feature.

Integration fixture work extends WQ-134, not a new architecture proposal: migrate
and drift only an explicitly owned disposable database; close all resources on
setup/assertion failure; preserve original failures if rollback/cleanup also
fails. Before/after readiness plus exact expected SQLSTATE/constraint should
identify the intended failure, not just any failed statement. If maintaining
cause-chain helpers, bound traversal and detect cycles; current expectPgCode's
while loop assumes an acyclic ordinary Error chain.

Acceptance: all retained tests pass, the strengthened assertions prove their
stated properties, and source hashes remain bound to the audited snapshot until
implementation is separately authorized. No serializer/reader source was edited.
