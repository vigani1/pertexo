# Public contracts: file-by-file review

Scope: all 60 inventoried files in `packages/contracts`. All 26 source modules,
the generator, nine test files and six configuration files were read in full.
The 18 generated JSON files were parsed and checked against their fully read
producers, references, patterns and represented schemas/routes. They are treated
as generated data, not falsely counted as manually interpreted source lines.
Paths in the ledger are relative to `packages/contracts/`.

## File ledger

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `packages/contracts/src/artifact-transfer.ts` | KEEP | Four explicit capability/metadata routes, common errors and no-store response helper preserve the distinction between authenticated metadata and bearer capabilities. Keep only begin-upload idempotent at this contract. |
| `packages/contracts/src/artifacts.ts` | KEEP | One nine-domain manifest deterministically generates both artifacts per domain. Central list is useful duplication control, not a runtime service abstraction. |
| `packages/contracts/src/catalog.ts` | KEEP | Target-aware projection preserves recursive schema references separately for OpenAPI and client containers. Authenticated unfiltered discovery and empty query contract are explicit. |
| `packages/contracts/src/connections.ts` | KEEP | Explicit connection, destination-version/status and policy routes are a readable public contract. Shared parameters/problems avoid drift without hiding route-specific semantics. |
| `packages/contracts/src/errors/api-problem.ts` | KEEP | Canonical exhaustive problem manifest, constrained extension constructor, immutable metadata and separate safe-detail/severity policy are cohesive. Length is chiefly a domain table, not excessive branching. |
| `packages/contracts/src/http/artifact-transfer.ts` | KEEP | Strict immutable upload metadata, supported transport field values, bounded capability lifetime and pending-only PUT response exclude important impossible combinations. |
| `packages/contracts/src/http/catalog.ts` | KEEP | Release identities, bounded root document properties and list sizes define the public response shape. Pinned registry validation owns deeper schema-document limits; do not call this response validator a full hostile registry admission boundary. |
| `packages/contracts/src/http/connections.ts` | FIX: WQ-051 | Provider-discriminated credential requests, case-insensitive header exclusions and conservative mailbox validation are justified. A Latin-1-specific byte counter is incorrectly reused for unrestricted Unicode URLs. |
| `packages/contracts/src/http/failure-notification-destinations.ts` | KEEP | Reuses canonical browser-safe destination configuration and list bound. Version/status/policy requests are strict and intentionally separate from secret credentials. |
| `packages/contracts/src/http/http-field-value.ts` | KEEP | Tiny browser-safe transport predicate rejects unsupported control/non-Latin-1 values. Preserve HTAB and admitted legacy byte range; it is not a generic text validator. |
| `packages/contracts/src/http/identity-workspace.ts` | KEEP | Strict authoring/operation inputs, bounded pagination and secret-free profile/member/lifecycle outputs. Distinct user/workspace/membership states must not be merged because names overlap. |
| `packages/contracts/src/http/node-testing.ts` | FIX: WQ-052 | Discriminated validation/execution and explicit acknowledgement are good. Recursive `z.json()` input parsing occurs before the server's bounded canonicalizer and can overflow on a small deeply nested wire body. |
| `packages/contracts/src/http/schedules.ts` | KEEP | Recurrence union and separate desired/health state describe real independent concerns. Summary validation is not the authoritative cron parser. |
| `packages/contracts/src/http/transport-headers.ts` | KEEP | Shared CSRF/idempotency/media-type vocabulary is deliberate; explicit case pairs survive JSON Schema pattern export without relying on regex flags. |
| `packages/contracts/src/http/webhooks.ts` | FIX: WQ-053 | Runtime replay-secret rule is correct, but its `.superRefine` is absent from generated OpenAPI validation. Represent the already-existing rule structurally. |
| `packages/contracts/src/http/workflow-authoring.ts` | KEEP | Graph contract and lifecycle enums are reused; draft ETag conflict and lifecycle revision conflict remain distinct strict problems. Do not force them into a common revision type. |
| `packages/contracts/src/http/workflow-runs.ts` | KEEP | Public run/events omit checkpoint and storage internals. Unknown JSON input is intentionally bounded later; replay input presence is separately required. The 1,000-node response cap matches the database reader's explicit capacity failure, not silent truncation; broader large-run access remains a database/API review concern. |
| `packages/contracts/src/identity-workspace.ts` | KEEP | Named request/response schemas and explicit route metadata retain auth/session and deletion-operation differences. Local path/query helpers are sufficiently small. |
| `packages/contracts/src/index.ts` | KEEP | Deliberate public barrel avoids ambiguous transport-header exports while retaining package subpaths. Prefer subpaths in server callers as already tested. |
| `packages/contracts/src/node-testing.ts` | KEEP; regenerate for WQ-052 | Separate target projection handles recursive input/output definitions. Conditional idempotency is documented instead of falsely requiring it for validation-only requests. |
| `packages/contracts/src/openapi-primitives.ts` | KEEP | Small common builders hide actual repeated OpenAPI structure. Manifest/status mismatch fails closed. They do not need a generic route framework. |
| `packages/contracts/src/schedules.ts` | KEEP | Shared enable/disable command shape is legitimate; routes-only client metadata is the current artifact format, not a JSON validation schema. Do not change that version/shape incidentally. |
| `packages/contracts/src/schema-projection.ts` | KEEP; TEST: WQ-054 | Graph-specific structural override and target-relative `$defs` rebasing preserve the recursive graph contract. Recursive traversal here processes trusted bounded schema definitions, not request JSON; do not label it the same issue as WQ-052. |
| `packages/contracts/src/webhooks.ts` | KEEP; regenerate for WQ-053 | Management and signed ingress authority are separate. Current Content-Type parameter is supplemental metadata only: OpenAPI ignores that header parameter; requestBody media type remains authoritative. Improve the test claim in WQ-054. |
| `packages/contracts/src/workflow-authoring.ts` | KEEP | Long explicit route/schema declaration is coherent. Named lifecycle helper shares only genuinely identical archive/restore behavior; restore-version keeps its ETag semantics. |
| `packages/contracts/src/workflow-runs.ts` | KEEP | Start/replay/cancel/read/SSE are explicit; event stream is correctly modeled as frames carrying event data, not as one JSON response. |
| `packages/contracts/scripts/generate-artifacts.ts` | KEEP | Explicit check/write modes, bounded static filenames and byte comparison are appropriate. Check mode was used; no generated files were overwritten by this review. |
| `packages/contracts/test/artifact-transfer-contract.test.ts` | KEEP | Exercises immutable input exclusions, transport bytes, pending-only upload and no-store/security metadata across all routes. Table loops have concrete assertions. |
| `packages/contracts/test/catalog.test.ts` | KEEP | Exact property-limit acceptance and per-field overflow error path are meaningful; release identity and strict query checks are not replaced with snapshots. |
| `packages/contracts/test/contracts.test.ts` | REFACTOR/TEST: WQ-051/WQ-052/WQ-054 | Contains useful artifact/reference and security checks but bundles unrelated domain assertions into many large cases. A few negative fixtures violate more than the advertised invariant. Split by behavior and retain cross-document coverage. |
| `packages/contracts/test/failure-notification-destinations.test.ts` | TEST: WQ-054 | Canonical configuration and list bound are well checked. The “mixed kinds and invalid optimistic versions” example violates both simultaneously, so neither guard is independently protected. |
| `packages/contracts/test/package-contract.test.ts` | TEST: WQ-054 | Deliberate exports and selected application subpath imports are tested. Scanning only entrypoint text for `from 'node:` does not prove transitive browser safety. |
| `packages/contracts/test/schedules.test.ts` | KEEP | Runtime strictness and routes/OpenAPI agreement are useful. Keep route-template conversion local and controlled. |
| `packages/contracts/test/webhooks.test.ts` | TEST: WQ-053/WQ-054 | Proves runtime rejection of each replay credential but does not execute the generated schema. Share one valid trigger fixture and test the full positive/negative replay matrix. |
| `packages/contracts/test/workflow-activation-contract.test.ts` | KEEP | Exact canonical schema identity plus invalid legacy vocabulary prevents parallel lifecycle definitions. |
| `packages/contracts/test/workflow-lifecycle-contract.test.ts` | KEEP | Checks safe revisions, strict requests, conflict shape and distinct ETag/idempotency behavior for restoration operations. |
| `packages/contracts/package.json` | KEEP | Browser-safe runtime dependencies, deliberate exports, separate generation/check commands and pinned lint tooling. Do not upgrade dependencies merely because the CLI advertises a newer version. |
| `packages/contracts/redocly.yaml` | KEEP with explicit limitation | Formatting/license/server/operation-ID exemptions reflect current documents. Lint success does not prove runtime refinement parity; retain runtime/generated-schema tests as a separate gate. |
| `packages/contracts/tsconfig.json` | KEEP | Browser-facing source has no ambient Node types; NodeNext compiled architecture and workflow-model project reference remain intact. |
| `packages/contracts/tsconfig.test.json` | KEEP | Node types apply only to no-emit scripts/tests/config checking, not exported runtime contracts. |
| `packages/contracts/vitest.config.ts` | KEEP | Anchored package root and Node environment exclude generated runtime/dependency directories. |
| `packages/contracts/vitest.coverage.config.ts` | KEEP | All source files included; coverage thresholds complement, but cannot establish, semantic projection parity. |
| `packages/contracts/artifacts/artifacts.client-schema.json` | DATA/GENERATED: KEEP | Six named schemas match producer; strict upload/finalize, pending capability and lifetime bounds inspected. |
| `packages/contracts/artifacts/artifacts.openapi.json` | DATA/GENERATED: KEEP | Four routes; 46 local references; no-store and command headers checked by producer tests. |
| `packages/contracts/artifacts/catalog.client-schema.json` | DATA/GENERATED: KEEP | Four named schemas; five recursive references resolve in client container. |
| `packages/contracts/artifacts/catalog.openapi.json` | DATA/GENERATED: KEEP | Two discovery routes; 19 references resolve; registry identities and response schemas match producer. |
| `packages/contracts/artifacts/connections.client-schema.json` | DATA/GENERATED: regenerate only if WQ-051 changes projection | Twelve schemas match producer. Runtime custom URL-byte validation is not fully represented by string maxLength; do not claim identical acceptance for all refinements. |
| `packages/contracts/artifacts/connections.openapi.json` | DATA/GENERATED: KEEP producer ownership | Nine paths and 87 references resolve. Input/output secret separation and destination/policy routes checked. |
| `packages/contracts/artifacts/identity-workspace.client-schema.json` | DATA/GENERATED: KEEP | Nine named schemas, no local references; strict input versus safe output fields match producer. |
| `packages/contracts/artifacts/identity-workspace.openapi.json` | DATA/GENERATED: KEEP | Eight paths, 51 references; OIDC query fields, session and lifecycle operation metadata match producer. |
| `packages/contracts/artifacts/node-testing.client-schema.json` | DATA/GENERATED: WQ-052 | Seven named schemas, 15 references; preserve recursive JSON shape while documenting new preflight behavior. |
| `packages/contracts/artifacts/node-testing.openapi.json` | DATA/GENERATED: WQ-052 | Two paths, 40 references; keep validate 200 versus execute 202 and conditional idempotency. |
| `packages/contracts/artifacts/schedules.client-schema.json` | DATA/GENERATED: KEEP | Existing integer-version routes-only manifest contains three routes, no schema map. It is not claimed to validate response values. |
| `packages/contracts/artifacts/schedules.openapi.json` | DATA/GENERATED: KEEP | Three paths, four component schemas and 30 references resolve. |
| `packages/contracts/artifacts/webhooks.client-schema.json` | DATA/GENERATED: KEEP | Existing routes-only manifest contains five routes and explicit ingress body/header metadata; changing response schema need not alter this file. |
| `packages/contracts/artifacts/webhooks.openapi.json` | DATA/GENERATED: FIX WQ-053 through producer | Five routes and 46 references resolve, but the replay credential prohibition is missing from the generated response schema. Never patch generated JSON by hand. |
| `packages/contracts/artifacts/workflow-authoring.client-schema.json` | DATA/GENERATED: KEEP | Seventeen schemas and 83 references; structural graph runtime-bounds marker and draft/lifecycle conflict distinction preserved. |
| `packages/contracts/artifacts/workflow-authoring.openapi.json` | DATA/GENERATED: KEEP | Eight paths and 166 references; recursive graph rebasing, ETag responses and lifecycle acceptance checked. |
| `packages/contracts/artifacts/workflow-runs.client-schema.json` | DATA/GENERATED: KEEP | Ten schemas; run/event summaries contain no engine checkpoint or physical storage locator. |
| `packages/contracts/artifacts/workflow-runs.openapi.json` | DATA/GENERATED: KEEP | Five paths and 47 references; SSE media type and replay/start preconditions retained. |

## WQ-051 — count full Unicode when bounding a connection-test URL

**P2, FIX; J01/J04/J06/J11/J12.**

Locations: `src/http/connections.ts:utf8ByteLength` (line 63) and
`httpConnectionTestRequestSchema` (line 239); add focused cases in the extracted
connection contract suite described by WQ-054. Caller:
`apps/api/src/connections/connection-testing.ts:78` parses before reserving a
test and resolving/decrypting its credential. The secure HTTP implementation
later applies the actual 2,048-byte limit at
`packages/integrations/src/http/secure-http.ts:480`.

Current helper adds one byte for ASCII and two for every other code point. Its
comment is true for admitted HTTP credential fields, but not for the URL caller:

```ts
for (const character of value)
  bytes += character.charCodeAt(0) <= 0x7f ? 1 : 2;
```

Reproduced through the exported current-source request schema:
`https://provider.example.test/` plus 700 emoji has 1,430 UTF-16 code units and
2,830 UTF-8 bytes; the schema accepts it. The secure transport later rejects it
before network dispatch. This is boundary disagreement and unnecessarily late
failure after test/secret work, **not** a demonstrated SSRF or network-size bypass.

Correct the private helper for all Unicode (one/two/three/four-byte code points;
unpaired surrogate replacement matches UTF-8 encoding) or use an already
browser-compatible encoding primitive with valid package typing. This package
deliberately excludes Node and DOM ambient types, so importing `Buffer` or
casually adding Node types to access `TextEncoder` is not an acceptable fix.
Keep existing byte totals for ASCII/Latin-1 credential headers unchanged. Rename
or replace the Latin-1-only explanatory comment so future callers are not misled.

Test ASCII, Latin-1, three-byte BMP and supplementary characters, exact 2,048
bytes and one-byte excess, in otherwise-valid HTTPS URLs. Verify no API test
reservation, credential decrypt or provider client call occurs for rejected
inputs. Retain scheme/credential/fragment/length checks and deterministic header
canonicalization. Regenerate artifacts only if represented metadata changes.
Run contracts tests/check/typecheck plus the connection-test use-case regression.

## WQ-052 — bound node-test JSON before recursive schema parsing

**P2, FIX; J01/J06/J09/J11/J12.**

Locations: `src/http/node-testing.ts` manual input (line 42), validation sample
input (line 56), and their enclosing request schema. API call site:
`apps/api/src/node-testing/controller.ts:79`; later canonicalization is in
`apps/api/src/node-testing/validation.ts:161`.

`z.json()` recursively parses the value before that later bounded canonicalizer
can run. A valid serialized 20,059-byte request with `mode: 'validate'`, revision
1 and a 10,000-level nested array around null parses with `JSON.parse`, then
`nodeTestRequestSchema.safeParse(...)` throws `RangeError: Maximum call stack
size exceeded`. This is ordinary JSON, not a Proxy-only edge case. Source caller
inspection shows no request-value preflight before this parse. The generic API
filter maps unrecognized RangeError to internal failure, not the Zod invalid-
request path; full authenticated HTTP regression is required during the fix.

Add a browser-safe iterative preflight for the arbitrary JSON input fields,
before invoking recursive Zod validation. Preserve the existing server canonical
JSON depth ceiling of 256 for these samples rather than borrowing graph nesting
or node execution envelope limits. Use a clearly named local input-depth
constant with a parity test against the server-owned canonicalizer; do not
import its server-only module into browser contracts. Respect any stricter
execution-value limits at their current server seams.

The guard must stop at the bound without walking the entire excess structure,
reject cycles/non-JSON values safely for direct callers, and produce an ordinary
Zod issue at the input field. Ensure a failed preflight prevents recursive
`z.json()` from running. A `.refine()` added **after** `z.json()` does not fix it.
Do not solve it by catching every RangeError globally or silently changing the
sample value, null semantics, manual/prior-preview union or acknowledgement.

Tests:

- Serialized deep arrays and objects for both validate sample input and manual
  execute input; `safeParse` returns failure, never throws.
- Exact accepted depth and one beyond, representative valid scalars/arrays/
  objects, null, optional sample omission and strict request keys.
- Direct cyclic/accessor inputs do not hang or leak arbitrary trap failures.
- API request returns the stable invalid-request response with zero preview
  reservation/provider dispatch, rather than 500; exercise actual controller
  parsing with valid authorization and CSRF fixtures.
- Generated client/OpenAPI schemas retain usable recursive JSON shape and local
  references. Annotate runtime-only depth behavior explicitly if it cannot be
  faithfully emitted; never replace the published field with unconstrained `{}`.

Keep response-side JSON schemas separate: output already originates from bounded
execution/storage owners. Extend their tests if producer review exposes a real
gap, not as an automatic arbitrary-input rewrite. This fix is distinct from
WQ-008's For Each node configuration parser and WQ-010's canonicalizer work.

## WQ-053 — encode the replay/credential exclusion structurally

**P2, FIX/REFACTOR; J01/J03/J06/J09/J12/J14.**

Location: `src/http/webhooks.ts:39`, `webhookManagementCommandResponseSchema`;
generated owner `src/webhooks.ts`, `artifacts/webhooks.openapi.json`; regression
owner `test/webhooks.test.ts`.

The current response has independent `replayed`, optional `endpointKey` and
optional `signingSecret`, then `.superRefine` rejects secrets when replayed.
That refinement is absent from JSON Schema export. An Ajv 2020-12 validation
probe against the committed generated component accepted a valid trigger with
`replayed: true, endpointKey: 'a'.repeat(43)` while the runtime schema rejected
the same value. Formats were disabled in this isolated comparison; the UUID
patterns and other fields remained valid. The defect is a published contract
that allows an expressly forbidden combination, **not** proof that the server
actually disclosed a credential.

Replace the independent flags plus hidden refinement with a strict discriminated
union on `replayed`: the true branch contains trigger and no credential keys;
the false branch contains trigger and the existing optional credential fields.
Factor the common trigger field only if it improves clarity. Preserve all
currently valid provision/rotation combinations and the public response type's
use sites. If direct callers historically pass explicit undefined credential
keys, test that representation and choose a projection-compatible schema that
preserves its semantics rather than incidentally tightening unrelated inputs.

Regenerate from the producer. Test both runtime and generated response schemas
on the same independently specified matrix: replay without credentials accepted;
each credential/both on replay rejected; non-replay supported combinations
accepted; unknown fields rejected. Verify API replay routes still redact secrets
and do not regenerate them. Prefer a test-only JSON Schema validator already
available to tooling, declared directly if needed; no runtime dependency or
handwritten generated artifact patches.

Zod explicitly documents that some custom checks cannot be projected to JSON
Schema; this finding targets a rule that can be represented structurally, not
an impossible promise to encode every runtime invariant.
[Zod JSON Schema documentation](https://zod.dev/json-schema).

## WQ-054 — make contract tests prove one invariant and the real boundary

**P2, TEST/REFACTOR; J02/J04/J06/J12/J13/J14.**

The useful cross-domain checks in `test/contracts.test.ts` should remain, but
its 837 lines mix credential policy, node previews, identity schemas, artifact
drift, graph limits and run APIs. Split independent cases into focused local
files (for example `connections-contract.test.ts`, `node-testing-contract.test.ts`,
`identity-workspace-contract.test.ts`, `workflow-runs-contract.test.ts`,
`transport-headers.test.ts` and `schema-projection.test.ts`). Keep manifest,
all-artifact byte equality and all-reference resolution in the package-wide
suite. Avoid a new shared test framework or one file per assertion.

Specific weaknesses to correct, beyond the regressions above:

1. Credential aggregate-byte test uses one authorization value already over its
   per-header maximum. Use multiple individually valid headers whose aggregate
   alone exceeds 16,384 bytes, plus exact aggregate acceptance. Assert the
   intended issue, not only `success: false`.
2. In `test/failure-notification-destinations.test.ts`, the same example has
   `expectedVersion: 0` and an email config containing `channelId`. Split into
   valid config/invalid version and valid version/mixed config; add positive
   controls. Removing either check should fail its own named test.
3. For `test/package-contract.test.ts`, keep the export inventory test but add
   a real browser-resolution/bundle check of each public subpath, including
   transitive workspace imports. The existing direct-entrypoint regex misses
   re-exported Node dependencies and different import syntax. Use existing
   tooling and assert no builtins/server-only entrypoints; no compiler rewrite.
4. Add focused projection tests for nested `$defs` ownership and escaped pointer
   segments, preserving all-artifact resolution. When adding runtime custom
   validation, assert intended output shape rather than letting
   `unrepresentable: 'any'` silently erase a field's meaningful contract.
5. Rename/split the transport “same edges” test so it does not imply that an
   OpenAPI Content-Type **header parameter** enforces media-type validation.
   OpenAPI 3.1 ignores that parameter; test the `requestBody.content` media type
   and document runtime charset restrictions separately. Keep signed-ingress
   header requirements and runtime content-type tests.

The last point follows the
[OpenAPI 3.1 Parameter Object specification](https://spec.openapis.org/oas/v3.1.0#parameter-object).
It is a test/documentation correction, not authorization to remove runtime
content-type validation or change accepted webhook media types.

Acceptance: all existing assertions remain or are replaced by demonstrably
stronger cases; failures identify the tested field/invariant; contracts tests,
typecheck, generator check and OpenAPI lint pass. No new production abstraction
is needed for test organization.

## Verification and ordering

- `pnpm --filter @pertexo/contracts test`: 9 files / 50 tests passed.
- `pnpm --filter @pertexo/contracts contracts:check`: all 18 files match current
  deterministic generation; all nine OpenAPI documents pass configured lint.
- Parsed all generated JSON and enumerated schema/route/reference counts; all
  stored regex patterns compile under Unicode mode. Existing all-artifact tests
  verify every local reference resolves.
- Three current-source probes reproduced WQ-051 URL undercount, WQ-052 deep
  JSON overflow and WQ-053 runtime/generated-schema disagreement. No provider,
  database mutation, generated-file write or source fix was performed.

Implement WQ-051 and WQ-052 as separate boundary bug/regression units, WQ-053 as
one schema/producer/regression unit, and WQ-054 as focused test cleanup around
those changes. Broader API error-response enumeration and large-run read
capacity require the application/database review; this ledger does not claim
those areas completed.
