# Foundation review and exact risk dispositions

Date: 2026-09-12. Scope: artifact20, integrations33, contracts26, queue12,
observability11, rate-limit4 source files (106 total). All appear in at least
one current package report; presence is not proof of every path. See the
[source inventory](source-inventory.json) and [main plan](../remaining-work-plan.md).

## Implementation closeout

All repository-actionable foundation work is closed on the current source tree.
O01 records only bounded safe queue-exception classifications and preserves the
original thrown value even when a Proxy throws during prototype inspection.
O02 covers actual Nest and PG error-span export plus local telemetry lifecycle.
Every status message is stripped and exception objects use only the fixed
`Error`/`NonError` classifications; regex-shaped custom names and codes are not
trusted. The incompatible ioredis `<6` auto-instrumentation was removed from the
ioredis 6 runtime, whose bounded queue-owned metrics and enclosing queue span
remain.
I01/I02/I03 exercise stream deadlines and iterator cleanup, Node
DNS/HTTPS selection, and AWS-envelope runtime construction without network
calls. Q01 now has its own owner-accurate coverage cohort, Q02's missing
lifecycle cases are covered, and RL01's semantic Redis reply guards remain
intact. R01 explanations were corrected; R02 default provider factories remain
explicit adapter-boundary retentions rather than fabricated AWS evidence.

Fresh selected results include artifact store 287 tests at 98.06% statements /
96.06% branches, integrations 293 tests at 96.73% / 94.99%, and the dedicated
run-event publisher cohort at 53/54 statements and 18/22 branches. The current
risk snapshot contains 28 artifact, 1 contract, and 38 integration retained
rows; all are reviewed and none is new debt. The 74-row table below is the
planning snapshot and remains useful as its per-row rationale, but rows hit by
the completed tests no longer appear in the generated current snapshot.

## Original required and conditional work

- O01: synthetic-marker probe proved raw queue Error recording; sanitize recorded exception while preserving original rejection. HTTP instrumentation hooks do not protect queue-created spans.
- I01: public controlled clock/aborting iterator/ETIMEDOUT iterator tests now hit stream-redaction branches 21/22/23 at lines 189/197/198 in the fresh integrations coverage report; deployed streaming behavior remains external.
- I02: local module-substitute tests now hit node-transport branches 0/1/2 at lines 22/35/42, including mixed address families, HTTPS selection, pinned lookup, timeout, abort forwarding, and close/error behavior; actual deployed DNS/TLS remains external.
- R01: correct role, Transform invariant and stale generated-branch wording below.
- I03: no-network public factory tests cover aws-envelope-runtime config validation, bounded-client construction handoff, connection-key/context binding, and close ownership; live KMS behavior remains external.
- Q01: completed with a dedicated source-owning API publisher cohort; the API suite executes the canonical queue implementation once, so tests were not duplicated merely for counters.
- Q02: match remaining producer/consumer/Redis telemetry paths to current tests: constructor cleanup, closed readiness, ambiguous publication, late settlement, force-drain, observer failure, close failure and timers. Add only genuinely absent cases. No new queue behavior defect was demonstrated.
- O02: reconcile logger, Nest adapter, default telemetry composition and runtime missing branches; use synthetic-failure export tests for enabled non-HTTP instrumentations. Production trace retrieval is a separate OBS-006 gate.
- RL01: preserve atomic Lua and hashed dimensions; classify private bounds guards against public validation and existing malformed Redis result/TTL/transport tests. No new limiter bug was demonstrated.
- R02: retain explicit default S3/presigner/clock adapter construction exemptions or add useful local constructor/close characterization. Default construction is not itself an AWS canary.

## Exact 74-row planning snapshot

The surviving rows' full current source fingerprints are preserved in
[risk snapshot](risk-snapshot.json). These were proposed plan dispositions; the
generated snapshot is authoritative for current membership and fingerprints.

| File | Branch/location | Line | Disposition | Rationale or recipe |
| --- | --- | ---: | --- | --- |
| `packages/artifact-store/src/config.ts` | 5/0 | 88 | Retain unreachable | Both regions parse maxObjectBytes from the same shared environment field, so distinct limits cannot reach this postcondition without an internal parser defect. |
| `packages/artifact-store/src/control-ledger.ts` | 15/1 | 0 | Retain generated | V8 emits this branch without an executable source coordinate. The retained ledger adapter is exercised by append/read/reconciliation and readiness tests; this metadata-only location is not claimed as executed. |
| `packages/artifact-store/src/control-ledger.ts` | 54/1 | 0 | Retain generated | V8 emits this branch without an executable source coordinate. The retained ledger adapter is exercised by append/read/reconciliation and readiness tests; this metadata-only location is not claimed as executed. |
| `packages/artifact-store/src/control-ledger.ts` | 3/0 | 189 | Retain defensive | The canonical serializer accepts general JSON arrays for forward-compatible material; current validated ledger records do not contain array-valued fields. |
| `packages/artifact-store/src/control-ledger.ts` | 4/0 | 192 | Retain unreachable | Validated ledger material contains only JSON values and undefined object properties are filtered, so a function or symbol cannot reach this fail-closed branch. |
| `packages/artifact-store/src/control-ledger.ts` | 6/1 | 197 | Retain unreachable | Object keys are unique, so the canonical sort comparator cannot receive equal keys; ascending and descending ordering remain covered by canonical-record tests. |
| `packages/artifact-store/src/control-ledger.ts` | 36/0 | 402 | Retain unreachable | Schema bounds on every record field keep canonical command bytes below MAX_RECORD_BYTES; this postcondition protects future schema expansion. |
| `packages/artifact-store/src/control-ledger.ts` | 82/1 | 816 | R02: retain default / optional local test | The default path creates the real bounded S3 client; unit tests inject the typed client port and deployed AWS behavior remains ART-008 evidence. Local constructor/close tests can characterize wiring without AWS; deployed provider behavior remains external. |
| `packages/artifact-store/src/control-ledger.ts` | 86/1 | 846 | R02: retain default / optional local test | Production uses the real clock for readiness expiry while deterministic unit tests inject now; both share the same attestation logic. Local constructor/close tests can characterize wiring without AWS; deployed provider behavior remains external. |
| `packages/artifact-store/src/dual-region-artifact-store.ts` | 34/1 | 364 | Retain defensive | Configuration inputs create an owned primary store; fully injected inputs preserve the supplied primary instance. |
| `packages/artifact-store/src/dual-region-artifact-store.ts` | 35/0 | 366 | R01: wording correction; retain default | Branches35/0 and35/1 construct primary observer options;37/0 and37/1 construct recovery options. Keep injected/config ownership explicit; do not claim branch execution. |
| `packages/artifact-store/src/dual-region-artifact-store.ts` | 35/1 | 367 | R01: wording correction; retain default | Branches35/0 and35/1 construct primary observer options;37/0 and37/1 construct recovery options. Keep injected/config ownership explicit; do not claim branch execution. |
| `packages/artifact-store/src/dual-region-artifact-store.ts` | 36/1 | 372 | Retain defensive | Configuration inputs create an owned recovery store; fully injected inputs preserve the supplied recovery instance. |
| `packages/artifact-store/src/dual-region-artifact-store.ts` | 37/0 | 374 | R01: wording correction; retain default | Branches35/0 and35/1 construct primary observer options;37/0 and37/1 construct recovery options. Keep injected/config ownership explicit; do not claim branch execution. |
| `packages/artifact-store/src/dual-region-artifact-store.ts` | 37/1 | 375 | R01: wording correction; retain default | Branches35/0 and35/1 construct primary observer options;37/0 and37/1 construct recovery options. Keep injected/config ownership explicit; do not claim branch execution. |
| `packages/artifact-store/src/dual-region-artifact-store.ts` | 38/1 | 381 | Retain defensive | Injected stores honor explicit owned versus borrowed policy; config-created stores are always coordinator-owned. |
| `packages/artifact-store/src/dual-region-control-ledger.ts` | 14/1 | 0 | Retain generated | V8 branch 14 in packages/artifact-store/src/dual-region-control-ledger.ts has no source coordinate; explicit adjacent decisions are separately covered by the package tests. |
| `packages/artifact-store/src/dual-region-control-ledger.ts` | 73/1 | 0 | Retain generated | V8 branch 73 in packages/artifact-store/src/dual-region-control-ledger.ts has no source coordinate; explicit adjacent decisions are separately covered by the package tests. |
| `packages/artifact-store/src/dual-region-control-ledger.ts` | 9/1 | 67 | Retain defensive | A missing property on the opposite object cannot match a present canonical ledger value; this fallback makes asymmetric material comparisons false. |
| `packages/artifact-store/src/dual-region-control-ledger.ts` | 64/0 | 413 | Retain unreachable | After proving the longer page has exactly one extra record, that record must exist; this guard protects array/runtime contract drift. |
| `packages/artifact-store/src/dual-region-control-ledger.ts` | 70/0 | 452 | Retain defensive | Injected ledgers require explicit ownership options so the coordinator never guesses whether it may close caller resources. |
| `packages/artifact-store/src/dual-region-control-ledger.ts` | 71/0 | 464 | Retain defensive | Mixed config/ledger inputs or ownership on config inputs are rejected before region construction. |
| `packages/artifact-store/src/server-only.ts` | 0/1 | 0 | Retain generated | V8 branch 0 in packages/artifact-store/src/server-only.ts has no source coordinate; explicit adjacent decisions are separately covered by the package tests. |
| `packages/artifact-store/src/server-only.ts` | 0/0 | 3 | Retain unreachable | The server entry loads only under Node and package metadata marks it browser-false; this branch guards an unsupported bundler or runtime. |
| `packages/artifact-store/src/store.ts` | 12/1 | 0 | Retain unreachable | Every production caller of verifiedBody supplies the AbortSignal returned by requestSignal; that helper always creates or composes a signal, so the implicit no-signal arm cannot be reached through ArtifactStore.put, getStream, or validateDirectUpload. |
| `packages/artifact-store/src/store.ts` | 6/1 | 292 | R01: narrow invariant | Normal Transform decodeStrings behavior supplies Buffer chunks to _transform. Readable string emission does not establish reachability of the string fallback. |
| `packages/artifact-store/src/store.ts` | 47/1 | 891 | R02: retain default / optional local test | The default path creates the real S3 client; package tests inject the typed client port and deployed-provider behavior remains ART-008 evidence. Local constructor/close tests can characterize wiring without AWS; deployed provider behavior remains external. |
| `packages/artifact-store/src/store.ts` | 50/1 | 911 | R02: retain default / optional local test | The default presigner uses AWS getSignedUrl; tests inject the bounded presigner port and deployed signing remains external evidence. Local constructor/close tests can characterize wiring without AWS; deployed provider behavior remains external. |
| `packages/contracts/src/http/webhooks.ts` | 0/1 | 0 | Retain generated | V8 reports an implicit module-initialization fallthrough without a source location; every explicit webhook credential-disclosure decision is exercised through the public schema. |
| `packages/integrations/src/crypto/envelope-cipher.ts` | 16/0 | 314 | Retain unreachable | Node crypto always returns a sixteen-byte authentication tag for aes-256-gcm, so this postcondition requires a runtime contract violation. |
| `packages/integrations/src/crypto/envelope-cipher.ts` | 20/0 | 389 | Retain defensive | Authenticated decryption of bounded ciphertext preserves the plaintext bound; this guard fails closed if a crypto provider violates that invariant. |
| `packages/integrations/src/email/executor.ts` | 14/1 | 0 | Retain generated | V8 reports this implicit fallthrough without a source coordinate; explicit adjacent decisions are separately exercised through the public package boundary. |
| `packages/integrations/src/http-request/executor.ts` | 7/1 | 0 | Retain generated | V8 branch 7 in packages/integrations/src/http-request/executor.ts has no source coordinate; explicit adjacent decisions are separately exercised through the public package boundary. |
| `packages/integrations/src/http-request/executor.ts` | 10/1 | 0 | Retain generated | V8 branch 10 in packages/integrations/src/http-request/executor.ts has no source coordinate; explicit adjacent decisions are separately exercised through the public package boundary. |
| `packages/integrations/src/http-request/executor.ts` | 33/1 | 0 | Retain generated | V8 branch 33 in packages/integrations/src/http-request/executor.ts has no source coordinate; explicit adjacent decisions are separately exercised through the public package boundary. |
| `packages/integrations/src/http-request/executor.ts` | 0/0 | 50 | Retain defensive | HttpRequestExecutorError accepts failure decisions only; every typed constructor excludes succeeded, so this rejection cannot be reached by a valid caller. |
| `packages/integrations/src/http-request/executor.ts` | 15/0 | 190 | Retain defensive | The strict public configuration schema proves the target protocol is HTTPS before execution reaches this redundant fail-closed adapter check. |
| `packages/integrations/src/http/address-policy.ts` | 5/1 | 33 | Retain unreachable | Node isIP already proved a four-octet IPv4 address, so malformed counts and missing-octet fallbacks cannot reach the private parser. |
| `packages/integrations/src/http/address-policy.ts` | 8/0 | 48 | Retain unreachable | Node isIP already proved a four-octet IPv4 address, so malformed counts and missing-octet fallbacks cannot reach the private parser. |
| `packages/integrations/src/http/address-policy.ts` | 11/1 | 54 | Retain unreachable | Node isIP already proved a four-octet IPv4 address, so malformed counts and missing-octet fallbacks cannot reach the private parser. |
| `packages/integrations/src/http/address-policy.ts` | 12/1 | 55 | Retain unreachable | Node isIP already proved a four-octet IPv4 address, so malformed counts and missing-octet fallbacks cannot reach the private parser. |
| `packages/integrations/src/http/address-policy.ts` | 13/1 | 56 | Retain unreachable | Node isIP already proved a four-octet IPv4 address, so malformed counts and missing-octet fallbacks cannot reach the private parser. |
| `packages/integrations/src/http/address-policy.ts` | 14/1 | 57 | Retain unreachable | Node isIP already proved a four-octet IPv4 address, so malformed counts and missing-octet fallbacks cannot reach the private parser. |
| `packages/integrations/src/http/address-policy.ts` | 15/0 | 67 | Retain defensive | The generic IPv4 prefix matcher supports a zero-length prefix although the pinned blocked-range snapshot currently contains no /0 entry. |
| `packages/integrations/src/http/address-policy.ts` | 16/0 | 73 | Retain unreachable | Node isIP already proved a complete unscoped IPv6 address, so malformed halves, segments, and embedded IPv4 positions cannot reach the private parser. |
| `packages/integrations/src/http/address-policy.ts` | 17/0 | 75 | Retain unreachable | Node isIP already proved a complete unscoped IPv6 address, so malformed halves, segments, and embedded IPv4 positions cannot reach the private parser. |
| `packages/integrations/src/http/address-policy.ts` | 18/1 | 76 | Retain unreachable | Node isIP already proved a complete unscoped IPv6 address, so malformed halves, segments, and embedded IPv4 positions cannot reach the private parser. |
| `packages/integrations/src/http/address-policy.ts` | 19/1 | 77 | Retain unreachable | Node isIP already proved a complete unscoped IPv6 address, so malformed halves, segments, and embedded IPv4 positions cannot reach the private parser. |
| `packages/integrations/src/http/address-policy.ts` | 20/0 | 79 | Retain unreachable | Node isIP already proved a complete unscoped IPv6 address, so malformed halves, segments, and embedded IPv4 positions cannot reach the private parser. |
| `packages/integrations/src/http/address-policy.ts` | 21/1 | 80 | Retain unreachable | Node isIP already proved a complete unscoped IPv6 address, so malformed halves, segments, and embedded IPv4 positions cannot reach the private parser. |
| `packages/integrations/src/http/address-policy.ts` | 24/0 | 96 | Retain unreachable | Node isIP already proved a complete unscoped IPv6 address, so malformed halves, segments, and embedded IPv4 positions cannot reach the private parser. |
| `packages/integrations/src/http/address-policy.ts` | 25/0 | 101 | Retain unreachable | Node isIP already proved a complete unscoped IPv6 address, so malformed halves, segments, and embedded IPv4 positions cannot reach the private parser. |
| `packages/integrations/src/http/address-policy.ts` | 27/1 | 114 | Retain unreachable | Parsed IPv6 addresses and the pinned network snapshot contain every fixed word position, so missing-word fallbacks cannot be selected. |
| `packages/integrations/src/http/address-policy.ts` | 28/1 | 114 | Retain unreachable | Parsed IPv6 addresses and the pinned network snapshot contain every fixed word position, so missing-word fallbacks cannot be selected. |
| `packages/integrations/src/http/address-policy.ts` | 30/1 | 120 | Retain unreachable | Parsed IPv6 addresses and the pinned network snapshot contain every fixed word position, so missing-word fallbacks cannot be selected. |
| `packages/integrations/src/http/node-transport.ts` | 1/1 | 0 | Retain generated | V8 branch 1 in packages/integrations/src/http/node-transport.ts has no source coordinate; explicit adjacent decisions are separately exercised through the public package boundary. |
| `packages/integrations/src/http/node-transport.ts` | 0/0 | 22 | I02: verified local adapter test | `test/node-transport.test.ts` uses a mocked Node DNS module to return IPv4 and IPv6 answers and verifies frozen normalized results; no provider request occurs. |
| `packages/integrations/src/http/node-transport.ts` | 0/1 | 22 | I02: verified local adapter test | `test/node-transport.test.ts` exercises the IPv4 and IPv6 family conversion arms through `NodeDnsResolver`; both arms hit in the fresh package coverage report. |
| `packages/integrations/src/http/node-transport.ts` | 2/0 | 42 | I02: verified local adapter test | `test/node-transport.test.ts` selects HTTPS through a controlled request module, verifies URL hostname/SNI preservation, pins both lookup callback forms, forwards signal/timeout, and asserts close/error cleanup. |
| `packages/integrations/src/http/node-transport.ts` | 3/1 | 56 | Retain unreachable | Node supplies a numeric status in a valid response callback; zero is retained only as a fail-closed runtime-protocol fallback. |
| `packages/integrations/src/http/outcome-policy.ts` | 28/0 | 153 | Retain unreachable | Cancellation is handled before generic secure-error kind derivation, so the later canceled switch arm cannot be reached. |
| `packages/integrations/src/http/outcome-policy.ts` | 28/12 | 170 | Retain unreachable | SecureHttpErrorCode is closed and every declared member has an explicit switch arm, making the default unreachable for typed callers. |
| `packages/integrations/src/http/secure-http-request.ts` | 21/0 | 160 | Retain unreachable | parseTargetUrl receives raw strings and creates SecureHttpError only in its catch block, so the caught value cannot already be that error. |
| `packages/integrations/src/http/secure-http.ts` | 24/0 | 446 | Retain unreachable | A non-empty DNS set either pushes every validated address or throws, so the selected sorted address cannot be undefined. |
| `packages/integrations/src/http/stream-redaction.ts` | 3/0 | 31 | Retain unreachable | Without redaction patterns, raw-byte accounting already enforced the same remaining budget, so this duplicate guard is invariant-only. |
| `packages/integrations/src/http/stream-redaction.ts` | 4/1 | 38 | Retain unreachable | The surrounding branch has proved the redaction-pattern array is non-empty, so the first-pattern fallback cannot be selected. |
| `packages/integrations/src/http/stream-redaction.ts` | 12/0 | 77 | Retain unreachable | The loop condition proves the indexed byte is inside the Uint8Array; undefined requires a nonconforming typed-array implementation. |
| `packages/integrations/src/http/stream-redaction.ts` | 14/0 | 126 | Retain defensive | The append helper and raw-byte counter enforce the output limit before emit; this aggregate check protects future algorithm changes. |
| `packages/integrations/src/http/stream-redaction.ts` | 21/0 | 189 | I01: verified public test | `test/stream-redaction.test.ts` controls monotonic time so the processing deadline expires before a yielded chunk; the exact timed-out mapper arm is hit without a scheduler race. |
| `packages/integrations/src/http/stream-redaction.ts` | 22/0 | 197 | I01: verified public test | `test/stream-redaction.test.ts` aborts immediately before an iterator rejection and observes the canceled classification, ambiguous dispatch state, and response close. |
| `packages/integrations/src/http/stream-redaction.ts` | 23/0 | 198 | I01: verified public test | `test/stream-redaction.test.ts` rejects the body iterator with `code: 'ETIMEDOUT'`, distinct from dispatch timeout, and verifies the ambiguous timed-out result and response close. |
| `packages/integrations/src/provider-dispatch-fence.ts` | 2/1 | 0 | Retain generated | V8 reports an implicit early-return fallthrough without a source location; provider dispatch evidence error classes are exercised through the public executor boundary. |
| `packages/integrations/src/server-only.ts` | 0/0 | 3 | Retain unreachable | The server export loads only under Node and is browser-false in package metadata; this branch guards unsupported bundlers or runtimes. |
| `packages/integrations/src/slack/executor.ts` | 16/1 | 0 | R01: correct prose; retain generated | Current row is16/1, not branch15. Source-less metadata is not an executable provider scenario. |
