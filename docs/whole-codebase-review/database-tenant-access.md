# Database tenant access, identity and OIDC persistence

Date: 2026-09-12. Primary reviewer fully read all 16 files below, plus the
previously reviewed transaction owner and installed pg 8.23.0 query handling.
Three unit files passed (4 tests, 118 ms). Disconnected driver probes reproduced
ignored query signals; injected source probes reproduced invalid expiry admission
and metadata stack overflow. Integration code was read, not run. No database,
identity provider or external encryption service was contacted.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `packages/database/src/tenant-access/identity-workspace-contracts.ts` | KEEP; CONDITIONAL WQ-142 | Ordinary readonly domain records and Pick-based store interfaces are understandable. Workspace creation result carries unused revokedSessionCount and broad lifecycle fields; clarify creation snapshot versus arbitrary workspace record. |
| `packages/database/src/tenant-access/identity-workspace-errors.ts` | KEEP | Stable identity/lifecycle reasons allow callers to distinguish policy conflicts without raw database details. Keep these domain errors, not a new universal hierarchy. |
| `packages/database/src/tenant-access/identity-workspace-identity-store.ts` | KEEP; TEST/REFACTOR WQ-141/WQ-142 | Exact issuer/subject lock and re-read make concurrent resolution coherent; never auto-link by email. Shared validation/error policy should cover direct create/link and transactional resolution consistently. |
| `packages/database/src/tenant-access/identity-workspace-member-store.ts` | KEEP; TEST WQ-143 | Scoped bounded tuple pagination retains PostgreSQL microseconds and rechecks actor authority with share locks. Those locks and separate authorization/read queries are meaningful, not excess conditions. |
| `packages/database/src/tenant-access/identity-workspace-session-store.ts` | FIX/TEST WQ-140/WQ-141 | Atomic revoke and active-user joins are appropriate. QueryConfig.signal is ignored by installed pg, and NaN expiry passes the future-date predicate. |
| `packages/database/src/tenant-access/identity-workspace-support.ts` | FIX/TEST WQ-141; REFACTOR WQ-142 | Metadata key filtering and bounded SQLSTATE translation have valid roles. Recursive parsing precedes the byte bound; aliases and duplicated error-code inspection reduce locality. |
| `packages/database/src/tenant-access/identity-workspace-rows.ts` | KEEP; TEST WQ-141/WQ-142 | Strict selected-row schemas make projection contracts visible. Metadata validation repeats the recursion issue; broad workspace type includes deleted although created_by must parse as UUID. Scope that claim to actual callers. |
| `packages/database/src/tenant-access/identity-workspace.ts` | KEEP; REFACTOR/TEST WQ-142 | Aggregate creation, idempotency, owner membership and audit share one transaction. Request hashing intentionally excludes generated workspace ID and preserves replay. Make workspace-specific implementation distinct from runtime assembly without fragmenting each SQL call. |
| `packages/database/src/tenant-access/oidc-login-transactions.ts` | KEEP; FIX/TEST WQ-141; REFACTOR WQ-142 | Row lock and committed consume-before-open prevent reuse and avoid external encryption inside a transaction. Finite expiry validation and discriminated consume result need improvement; preserve binding/expiry/replay precedence. |
| `packages/database/src/tenant-access/workspace-policy.ts` | KEEP | Framework-free capability sets are explicit and frozen; inversion over five roles is bounded and clearer than a cache or bitmask. Don't merge capabilities that happen to share roles today. |
| `packages/database/src/tenant-access/testing.ts` | KEEP | Explicit fixture exports collect the legitimate tenant/identity contracts. Production still uses role subpaths; no need for wrapper implementations. |
| `packages/database/test/workspace-authorization-policy.test.ts` | KEEP; TEST WQ-143 | Exhaustively checks capability membership/inversion over declared sets. Owner expectation intentionally follows all capabilities; add explicit independent capability vocabulary coverage when changing policy. |
| `packages/database/test/identity-workspace-session-cancellation.test.ts` | FIX/TEST WQ-140 | Proves forwarding to an invented signal-aware fake, not pg cancellation. It misses already-aborted input and resource disposal. Preserve forwarding evidence only as a subordinate adapter assertion. |
| `packages/database/test/identity-workspace.integration.test.ts` | KEEP; FIX fixture/TEST WQ-143 | Valuable real concurrent identity, replay, RLS, role denial, OIDC capacity and member cursor cases. Shared mutable fixture and whole OIDC-table deletion require isolated database ownership; several outcomes need exact rather than generic assertions. |
| `packages/database/test/oidc-browser-binding-migration.test.ts` | KEEP | Static guard accurately labels intended 0071 DDL/backfill; it complements, not replaces, the populated prior-head upgrade. |
| `packages/database/test/oidc-browser-binding-migration.integration.test.ts` | KEEP; TEST WQ-143 | Disposable database, populated prior-head row and finally-owned directory prove migration intent when executed. Add successful binding-aware new insert; current no-binding rejection alone is incomplete new-contract evidence. |

## WQ-140 — use the existing cancellation-aware owner for session lookup

P2 FIX/TEST. `identity-workspace-session-store.ts:78–88` spreads signal into
pool.query's configuration. The installed pg 8.23.0 Query constructor does not
read it, and Client.query does not register cancellation. The telemetry wrapper
forwards it unchanged. The [official client API](https://node-postgres.com/apis/client)
documents query/statement timeouts; those are not caller AbortSignal support.
Installed code and the controlled probe, not absence from documentation alone,
establish this finding.

Probe: constructed a real pg.Client without connect, forwarded the actual store
query to Client.query, and observed one event-loop turn before manually failing
and draining the synthetic queued query. Both pre-aborted and abort-after-start
cases produced `{ settled: false, queued: 1, queryHasSignal: false }`. Both
clients were ended; there was no TCP connection. This establishes ignored
cancellation, not a measured production query duration. Role query/statement
timeouts still provide bounds; don't claim infinitely unbounded production SQL.

Use withPlatformTransaction's existing acquisition, abort-driven client disposal,
late-checkout cleanup and listener lifecycle for this platform-global read, or
reuse its proven ownership internals if avoiding an extra transaction is justified
by measurement. Prefer the existing public seam first. Preserve digest validation,
active-user/expiry/revocation predicates, null result and no tenant-context leakage.
Do not implement Promise.race alone and return an actively querying client to the
pool. Do not upgrade the driver speculatively to avoid fixing the false contract.

Acceptance: pre-aborted lookup does no checkout; queued acquisition abort returns
promptly and disposes a later checkout; abort during query removes/destroys the
owned client; normal success/null/error paths release once and remove listeners.
Keep stable application abort behavior. Add an authorized disposable blocked-query
test that proves backend/client disposal, plus deterministic owner tests. Replace
the fake that implements functionality absent from pg. Rerun API stream/session
disconnect behavior after this fix; signal forwarding alone is insufficient.

## WQ-141 — validate finite dates and bounded metadata before work

P2 FIX/TEST. Session create at `identity-workspace-session-store.ts:36–42` and
OIDC create at `oidc-login-transactions.ts:104–110` check:

```ts
!(expiresAt instanceof Date) || expiresAt.getTime() <= Date.now()
```

Invalid Date returns NaN, and NaN <= now is false. Source-injected probes showed
one session SQL call, and **two OIDC seal calls plus one SQL call**, with invalid
expiry. No real SQL/encryption executed. Validate a finite timestamp and future
bound before either operation. Keep time policy explicit and pass a captured now
or existing clock seam where tests need boundary equality. Test invalid/non-Date,
equal, past and future values; invalid input must cause zero encryption/SQL work.
This is early-validation failure, not proof the database persists an invalid date.

`identity-workspace-support.ts:12–45` first runs recursive z.json(), then
JSON.stringify for 8 KiB, then recursive unsafe-key inspection. A source probe
with 4,000 nested objects yielded RangeError instead of a controlled input error.
`identity-workspace-rows.ts:13–15` repeats this pattern. Use the established bounded
JSON admission pattern before recursion, with explicit byte/depth/item limits and
JSON/plain-data rules appropriate to identity metadata. Preserve key rejection
at every depth, no credential contents in errors, deterministic request hashing,
and independently validated persisted rows. Test cyclic/deep/wide input and exact
byte limits, nested arrays and forbidden keys; establish service reachability and
upstream limits before labeling this a remote denial-of-service vulnerability.

Direct createUser currently validates only part of the same name/email contract
that resolveOrCreateIdentity and row schemas enforce. Share a small named input
schema if doing so preserves trim/case and conflict behavior; reject overlength
before SQL. SQL remains the final authority. Do not silently change email matching
or identity-link semantics as part of validation cleanup.

## WQ-142 — localize identity persistence responsibilities and result states

P2/P3 REFACTOR/CONDITIONAL. Preserve current public capabilities and transactional
invariants; this is not a new identity architecture.

1. `identity-workspace.ts:79–240` contains creation snapshot serialization,
   canonical request hashing and claim/complete SQL, followed by runtime assembly
   interleaved with aggregate creation and lifecycle methods. If restructuring,
   move coherent workspace persistence behind a package-private
   createIdentityWorkspaceWorkspaceStore(pool), mirroring existing identity,
   session and member stores. Keep creation's claim, aggregate writes and result
   completion visibly in one transaction. Compare resulting navigation cost;
   don't split claim/map/query into one-function files or add a second public
   runtime interface. If no locality gain, retain the module and only normalize
   import placement/aliases (`parseMetadata`, `databaseConflict`) to honest names.
2. OidcTransactionConsumeResult currently permits `{ status: 'ok' } without a
   transaction and failure statuses with one. Use an ordinary discriminated union:

   ```ts
   type ConsumeResult =
     | { readonly status: 'ok'; readonly transaction: OidcLoginTransaction }
     | { readonly status: 'missing' | 'expired' | 'replayed' | 'binding_mismatch' };
   ```

   Compile every adapter/caller and retain runtime validation at injected seams.
   Never move decryption inside the row lock. A failed open after committed consume
   must remain consumed; wrong binding must not consume; concurrent consume has
   exactly one success. Add those explicit failure tests, including malformed
   stored seal fields without String coercion concealing null/type corruption.
3. Creation replay serializes revokedSessionCount=0 although the public create
   method returns only workspace. Clarify why this historical stored shape exists;
   do not remove fields from already-persisted result_ref without compatibility
   parsing. Creation schema omits purging while generic WorkspaceStatus includes
   it, and workspace row mapper rejects null created_by despite deleted being an
   allowed status. Current mapper caller inserts an active workspace, so this is
   not an evidenced broken deleted-workspace read. Narrow/document creation
   snapshot semantics or add a distinct general mapper only for an actual caller.
4. SQLSTATE reads are repeated in support, link, session and OIDC paths. Reuse a
   bounded nonthrowing local code extractor if changing them; preserve raw unknown
   failures and causes, don't classify every exception as a domain conflict. The
   transactional resolve path currently returns raw unique-email violation while
   direct create maps it. Pin the API's intended conflict result before unifying;
   never auto-link different issuer/subject identities by matching email.

Acceptance: public package/type builds pass; unchanged replay hashes and stored
legacy result decoding; concurrent first-login and workspace creation remain
atomic; OIDC failure precedence and consume-before-open survive; fewer knowledge
locations, not simply fewer lines or more files. No ADR needed for this focused
behavior-preserving organization unless the identity contract itself changes.

## WQ-143 — isolate identity integration fixtures and sharpen assertions

P2 FIX fixture/TEST. `identity-workspace.integration.test.ts:90–158`
replaceOidcTransactions deletes **every** row in app.oidc_login_transactions and
temporarily disables its capacity trigger in the configured migration database.
This is necessary capacity setup only inside an owned disposable database.
Serial Vitest files do not protect an independently running application or test
command. Move this suite to the existing disposable fixture and don't execute it
against a potentially shared configured database until that is resolved.

- Create runtime owners within registered fixture lifetime rather than starting
  monitors at module evaluation. Place pool.connect inside ownership try/finally;
  checkout failure currently skips end in multiple helpers. Attempt all afterAll
  closes even if the first rejects, then drop the exact owned database.
- Per-test workspace/member fixtures should replace mutation of the shared owner
  membership. The atomic aggregate test expects exactly one member, while the
  later pagination case adds members. Independent or shuffled tests should still
  pass. Use fixture-relative counts only when deliberately proving an aggregate.
- Pagination should exhaust pages and compare the full expected membership set,
  including equal timestamp UUID tie-breaks, differing microseconds, suspended
  membership inclusion, removed membership exclusion and inactive user exclusion.
  Current first/second-page inequality is useful but insufficient. Preserve the
  existing valid ordered partial-index catalog assertion and invalid calendar/year
  zero cases; those are stronger than a substring-only schema test.
- No-email-auto-link currently asserts generic Error for different issuer/subject
  with the same email. Pin the chosen public error after WQ-142 contract check,
  assert no new user/identity/session rows and retain the original association.
  Add concurrent direct link and resolve interactions if both are supported paths.
- OIDC tests use a reversible base64 fixture adapter: describe them as persistence
  and associated-data tests, not cryptographic qualification. Add missing, corrupt
  seal, first/second open failure and committed-consumption assertions. Capacity
  limits, bounded stale deletion and concurrent one-winner cases should remain
  real PostgreSQL tests on the owned database, not mocks.
- The 0071 upgrade test properly owns its temporary directory. Retain old active
  state invalidation and missing-binding failure; also prove a new valid bound row
  is accepted after upgrade. Reuse migration-history suffix helper only when the
  assertion means all successors, without deriving expected history from runtime.

Order: WQ-140 cancellation, WQ-141 input safety, isolated fixtures and exact
failure evidence, then the gated WQ-142 organization. No source, SQL, service,
commit or push was changed by this review.
