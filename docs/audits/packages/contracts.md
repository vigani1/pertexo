# `@pertexo/contracts` implementation and architecture audit

## Review identity and conclusion

- **Audited commit:** `7e4b37840a2b86c591046e16f1de834e8da2db79`
- **Audited tree:** `8481ebf86f4b36ff70687f86a2bb7933a00d65b8`
- **Production scope:** all 18 source files and all 2,890 physical source
  lines; all 14 committed generated artifacts and their 17,280 lines were also
  inspected.
- **Test scope:** all five test files and all 836 physical test lines, artifact
  generation/check scripts, every API consumer, controller-route parity,
  downstream schema parsing, package scripts, and CI.
- **Architecture sources:** the authoritative backend plan; RFC 9457; OpenAPI
  3.1; and applicable ADRs 002, 004, 011, 014, 016, 022, 025, and 026.
- **Independent validation:** Redocly CLI 2.51.2 with its minimal ruleset.
- **Audit status:** granularly certified for the pinned implementation tree.
- **Implementation status (2026-09-05):** CON-001 through CON-011 are
  implemented and verified. Contract validity, semantic projection, import
  boundaries, problem metadata, registries, package coverage, and the root
  source-hashed risk ledger are continuous gates.

## Remediation reconciliation

| Finding | Final status | Current evidence |
| --- | --- | --- |
| CON-001 | Fixed | `b4f2b22`; all client/OpenAPI references resolve, Response Objects are valid, path parameters are declared, and seven OpenAPI documents pass pinned Redocly validation. |
| CON-002 | Fixed | `b4f2b22`, `078cd53`; the generated workflow graph is recursive and structurally represents the authoritative workflow-model contract and limits. |
| CON-003 | Fixed; continuous gate | `b4f2b22`; `contracts:check` verifies deterministic bytes and structurally lints every OpenAPI artifact in protected CI. The validator is pinned to Redocly CLI 2.51.2; the protected dependency review rejected the former 1.34.5 toolchain after a high-severity Faker advisory, and the upgrade removed that vulnerable transitive graph. |
| CON-004 | Fixed | `47b7fa6`, `1e8ec80`; one package-private typed assembly owner supplies shared OpenAPI and authenticated components while routes remain domain-local. |
| CON-005 | Fixed | `b4f2b22`, `9969ff7`; expressible bounds are projected, runtime-only refinements are explicit, and differential boundary tests cover header/list/graph semantics. |
| CON-006 | Fixed | `1153d3f`; applications import domain subpaths and a boundary test forbids runtime root aggregation imports. |
| CON-007 | Fixed | `b4f2b22`, `9969ff7`; credential values enforce the Node HTTP field-value set with exhaustive control-byte and accepted Latin-1 coverage. |
| CON-008 | Fixed | `078cd53`; public lifecycle/delivery result contracts use strict discriminated states and reject contradictory combinations. |
| CON-009 | Fixed; continuous gate | `19ae523`, `6c49c7e`; all package source is thresholded and root source-hashed review has zero unreviewed contract branches. Fresh coverage is 100% statements/lines/functions and 98.36% branches (60/61). |
| CON-010 | Fixed | `325fd88`; one browser-safe problem manifest owns code/status/type/title and is consumed by schemas, API mapping, documentation, and tests. |
| CON-011 | Fixed | `dc4dea1`, `59a1dca`; list bounds and artifact/export registries have one owner, unused aliases are removed, and schema-reference helpers remain package-private. |

The package is necessary. It is the browser-safe Interface for request,
response, problem, client-schema, and OpenAPI contracts. Runtime Zod schemas
are generally strict, bounded, and used by the API at real input/output seams.
Credential requests exclude secrets from responses, graph ownership remains in
workflow-model, ETags and idempotency values are explicit, and generated files
are deterministic and checked for byte drift in CI.

The committed API artifacts are not currently trustworthy. Independent OpenAPI
validation found 85 structural errors even with nonessential style rules
downgraded. Node-testing and workflow-authoring contain unresolved references;
schedules and webhooks add an invalid `status` property to Response Objects and
omit path parameters. The workflow draft client schema reduces `graph` to `{}`,
so it documents none of the authoritative graph constraints. The artifact
drift check proves only that broken output matches its generator.

The source also contains two generations of contract design. Identity,
connections, node testing, workflow authoring, and workflow runs use Zod-derived
schemas and common-shaped OpenAPI documents, although their helper code is
copied. Schedules and webhooks use small manually written route lists and
skeletal documents disconnected from their own Zod schemas. This drift should
be corrected before adding another public feature.

## Granular review certification

Certification was completed on 2026-09-04 at branch commit `a3068c1`. A
package-scoped diff against the audited implementation commit was empty, so the
package contents still match the pinned implementation tree above.

The certification read the complete contents of all 42 tracked package files:

- 18 production files and all 2,890 physical source lines;
- five test files and all 836 physical test lines;
- 14 generated JSON artifacts and all 17,280 physical generated lines; and
- `package.json`, the generation script, both TypeScript configurations, and
  the Vitest configuration (143 further lines).

Every exported schema/value/type, internal helper, route declaration,
generation branch, test, configuration field, and generated schema/path/
response value was included. Large generated documents were read by complete
JSON subtrees and then checked for whole-document schema-map equality where an
OpenAPI document embeds its corresponding client-schema map; truncated command
output was discarded and rerun in bounded sections. Direct API imports and the
controllers/use cases that consume package contracts were retraced separately.

This stricter pass did not identify a twelfth independent finding. It did
expand CON-001: unresolved root-local `$defs` references also make the
node-testing and workflow-authoring **client-schema** documents invalid, not
only their OpenAPI counterparts. A fresh whole-artifact reference/response/
path-parameter probe found:

- 15 unresolved references in each node-testing client/OpenAPI document;
- 40 unresolved references in each workflow-authoring client/OpenAPI document;
- 12 forbidden Response Object `status` fields and eight missing path-parameter
  declarations in schedules OpenAPI; and
- 18 forbidden Response Object `status` fields and 12 missing path-parameter
  declarations in webhooks OpenAPI.

CON-001 through CON-011 therefore remain the complete known issue set for this
package at the pinned tree. Certification means the review surface is complete;
it does not mean those open implementation findings are fixed.

## Evidence collected

| Check | Result |
| --- | --- |
| `pnpm --filter @pertexo/contracts test` | 5 files and 20 tests passed |
| `pnpm --filter @pertexo/contracts typecheck` | Passed |
| `pnpm --filter @pertexo/contracts build` | Passed |
| `pnpm --filter @pertexo/contracts contracts:check` | Passed; committed bytes match generated bytes |
| ESLint with repository Node heap setting | Passed |
| Fresh package-source V8 coverage | 94.16% statements, 48.57% branches, 89.83% functions, 94.81% lines |
| Redocly minimal validation | Failed with 85 errors and 114 warnings |
| Recommended Redocly validation | Failed with 161 errors and 47 warnings |
| Workflow graph client projection | `WorkflowDraftSaveRequest.properties.graph` is `{}` |
| Refinement projection | header count, total bytes, prohibited names, and case-insensitive uniqueness absent from JSON Schema |
| Root import probe | about 37.9 ms and 14.5 MiB heap growth on this host |
| Narrow error-schema import probe | about 16.2 ms and 3.5 MiB heap growth on this host |

Import timings are single-host diagnostics, not production SLOs. They confirm
that Node evaluates the root aggregation and constructs all contract documents;
tree-shaking does not apply to the unbundled runtime.

## Architecture, ownership, and dependency direction

### Module purpose

The package correctly depends only on Zod and workflow-model's browser-safe
contract subpaths. It has no NestJS, database, worker, Redis, provider, or Node
built-in dependency. Applications depend inward on the package; it does not
depend back on application controllers. `sideEffects: false` is valid for
bundlers because modules create immutable contract values without external
effects.

The intended layers are sensible:

- `src/http/*` owns Zod request/response values;
- domain facade files own client-schema and OpenAPI descriptions;
- `errors/api-problem.ts` owns shared RFC 9457 shape/codes;
- `artifacts.ts` owns deterministic output enumeration;
- `scripts/generate-artifacts.ts` performs check/write I/O.

### Depth, Interface size, and Locality

The runtime schemas are deep, but OpenAPI assembly is shallow and repeated.
Five files copy `jsonSchema`, `$ref`, request, response, problem, and parameter
builders. Schedules and webhooks then bypass those helpers entirely. These are
at least seven real callers of one stable Adapter seam, so extraction passes the
deletion test: a shared internal OpenAPI builder would delete repetition and
centralize correctness.

Use internal modules such as:

```text
src/
  http/...
  openapi/primitives.ts        references, bodies, parameters, problems
  openapi/schema-registry.ts   hoist/remap Zod definitions safely
  openapi/document.ts          root metadata/security/version policy
  domains/...                  routes plus domain schemas
  artifacts.ts                registry-derived emitted files
```

Do not create a generic framework detached from this repository. Keep domain
routes readable as data, but make the primitives enforce valid OpenAPI and
shared policy.

The package root has low Locality for runtime consumers. `index.ts` re-exports
every domain facade, which imports and constructs all client/OpenAPI documents.
Several API modules import one small schema from the root; in Node ESM this
loads the full contract suite. Prefer purpose-specific subpaths for application
runtime imports and reserve the root for tooling, or make root exports avoid
eager artifact construction (CON-006).

## Complete production-code review

### `src/errors/api-problem.ts`

The closed error-code vocabulary is valuable for clients and telemetry.
`apiProblemIssueSchema` and `apiProblemShape` bound path, message, detail,
instance, request ID, and issue count. `createApiProblemSchema` supports typed
extensions such as revision conflicts without duplicating the base shape.

The generic schema does not couple `code` to HTTP `status` or `type`; it accepts,
for example, an authentication code with any 4xx/5xx status. The API filter is
the current owner of that mapping. Generate a tested code/status/type manifest
and use it for both filter and OpenAPI examples so drift is detectable
(CON-010). Do not turn every error into a bespoke class solely for schema
precision.

RFC 9457 `type` is a URI reference, while the schema only requires a bounded
string. Current API output uses stable problem URIs; encode at least URI-reference
syntax or document why non-URI values are admitted.

### `src/http/identity-workspace.ts`

OIDC code/state and idempotency headers are bounded. Workspace name/slug and
deletion reason are trimmed and strict. Path identifiers are UUIDs. Lifecycle
responses exclude internal command payload and expose bounded error/result
fields.

Lifecycle response states are represented as one flat object. It permits
`completed` with no completion/result, `failed` with no error, or `pending` with
a completion result. Runtime producers are coherent, but clients cannot rely on
the schema to model the state machine (CON-008). A status-discriminated union
would make the Interface more useful.

`workspaceResponseSchema` does not reuse name/slug bounds from the request.
Database constraints currently protect output. Share field schemas so ingress
and egress cannot drift.

### `src/http/connections.ts`

This is the strongest contract file. Provider/auth/status vocabularies are
closed. HTTP credential names use token grammar; names are case-insensitively
unique, normalized and sorted; transport-controlled headers are prohibited;
header count and bytes are bounded. Slack/Resend credential shapes are strict,
and email domains normalize deterministically. Public responses exclude secret
material and expose only health/status metadata.

The header value validator rejects CR, LF, and NUL but accepts other invalid or
dangerous control bytes such as `0x01` and DEL. The Fetch `Headers` object on the
audited runtime also accepts those values, so later transport behavior becomes
implementation-dependent. Enforce RFC field-value bytes—visible characters,
obs-text if explicitly supported, plus only intentional whitespace—and test
the complete C0/DEL set (CON-007).

Connection test URL validation requires HTTPS and denies fragments/credentials.
Network target safety correctly remains in the secure HTTP Adapter because DNS
resolution and redirect checks cannot be proven by a string schema.

### `src/http/node-testing.ts`

Validate and test-execute are properly discriminated. Durable execution
requires explicit side-effect acknowledgement. Preview responses bound issue
counts and safe codes, expose only inline/artifact outputs, and contain no
credential or provider body fields.

`sampleInput`, manual input, and inline preview output use `z.json()` without
this package's byte/depth/member limits. API/worker persistence applies the
actual execution-value boundary, which protects production, but generated
clients cannot discover those limits. Reference a shared browser-safe bounded
JSON schema or publish explicit extension metadata and parity fixtures
(CON-005).

`previewRunSummarySchema` is a flat status object that admits outputs, errors,
and timestamps in contradictory states. Model stable status-specific invariants
where product clients depend on them (CON-008).

### `src/http/workflow-authoring.ts`

Strong opaque ETags, UUID params, bounded opaque cursors, pagination, strict
create/save shapes, separate draft/validation/version responses, and a typed
412 revision conflict are good API choices. Graph schema ownership correctly
comes from workflow-model rather than being duplicated.

The imported graph schema begins with a Zod custom preflight piped to the real
recursive schema. `z.toJSONSchema` projects that composition as `{}` when nested
under the save request. Consequently client and OpenAPI artifacts accept any
graph and expose none of its fields or limits (CON-002). This is a generation
defect, not a reason to duplicate the graph model manually.

The validation response permits at most 100 issues while workflow-model can
return more; the API serializer does not cap them. That integration defect is
recorded as WM-004 and must be fixed using one shared constant.

Several schema aliases (`workflowResponseSchema`, `workflowDraftSchema`,
`workflowValidationResponseSchema`, `workflowVersionSchema`, and list aliases)
encode identical concepts under multiple names. Retain only names with real
consumer compatibility value; aliases make generated/public inventory harder
to reason about (CON-011).

### `src/http/workflow-runs.ts`

Run/node status and trigger vocabularies are explicit. Start/cancel inputs are
small, IDs and text bounded, output references contain only identifiers, event
sequence is positive, and `Last-Event-ID` uses canonical decimal syntax.

`workflowRunStartRequestSchema.input` is `unknown`, not `z.json()`. HTTP JSON
parsing and the server's exact bounded execution-value seam protect production,
but direct contract consumers can pass host objects and generated schema cannot
express JSON or storage limits. Use a browser-safe JSON value schema plus
documented limits while retaining server revalidation (CON-005).

Run summaries, node summaries, and 20 event kinds share flat schemas with
mostly optional payload fields. They admit impossible combinations such as a
queued run with completion time, a ready node with an error, or `run.queued`
carrying an attempt output. The event streamer filters keys and parses shape but
does not enforce kind-specific semantics. Use discriminated event payload
families and status-aware response unions for invariants clients act on
(CON-008).

### `src/http/failure-notification-destinations.ts`

The file correctly reuses workflow-model's channel-neutral destination config,
uses optimistic version input, and exposes no secret. Creation, versioning,
status, policy, and response contracts are clear.

The list response has no maximum even though the database query is limited to
100. Add the same bound to document and verify the real guarantee (CON-011).
The imported destination schema's email normalization is a runtime transform
that JSON Schema cannot communicate; clients need canonicalization guidance.

### `src/http/schedules.ts`

Runtime schemas are strict and useful. They distinguish desired/reconciliation
status from health, model cron/interval recurrence, bound node/error fields,
include misfire policy, and cap lists at 1,000. Management commands use an
explicit empty body and return trigger plus replay status.

Timezone and cron strings are only bounded here. That is appropriate because
canonical IANA timezone/cron validation belongs to the schedule domain and
database seam, but client artifacts should describe the grammar or link to it.

### `src/http/webhooks.ts`

Credential tokens use the exact base64url length. Health responses omit secret
state, ingress responses are strict, and replayed management commands cannot
re-disclose credentials.

One shared management response schema permits either credential, both, or none
on any non-replayed operation. In reality provision returns both, endpoint
rotation returns only endpoint key, and secret rotation returns only signing
secret. Use operation-discriminated response schemas or separate named schemas
so clients know what a successful original command returns (CON-008).

### Domain client/OpenAPI files

`connections.ts`, `identity-workspace.ts`, `node-testing.ts`,
`workflow-authoring.ts`, and `workflow-runs.ts` follow a recognizable pattern:
derive named JSON schemas, describe routes, reference one RFC 9457 response
shape, declare cookie security, and publish a version. Their repeated helper
Implementations should be one internal Adapter (CON-004).

Even these richer documents are invalid in two domains. Zod emits internal
`#/$defs/...` references inside independently generated component schemas;
after embedding those values beneath `components.schemas`, the references point
at a nonexistent document-root `$defs`. Redocly found unresolved references in
node-testing and workflow-authoring. Unused nested `__schema*` definitions
confirm the registry was not hoisted/remapped (CON-001).

`schedules.ts` and `webhooks.ts` are a different, incomplete generation. Their
client artifacts list only methods/paths/headers and omit request/response
schemas. Their OpenAPI documents omit declared path parameters, operation IDs,
security, schema components, and real response bodies. `problem()` adds a
non-extension `status` field where OpenAPI forbids it and describes the problem
body only as `{ type: object }`. Redocly reported every such `status` as a
structural error (CON-001).

The richer documents also omit summaries/servers and sometimes unused
components. Those are quality warnings, not equivalent to structural errors.
Choose a documented server strategy suitable for generated clients and add
operation summaries/tags, but prioritize valid references and actual schemas.

### `src/artifacts.ts` and generation script

Artifact serialization is deterministic and the script cleanly separates
`--check` from `--write`. CI invokes `contracts:check`, so uncommitted drift is
caught. Writes are parallel but each target is unique.

The 14-entry list duplicates each domain twice and can drift from exports. Make
a single domain artifact registry produce client schema, OpenAPI, filename,
version, and export checks (CON-011). More importantly, run structural OpenAPI
validation and schema behavior checks before declaring generated bytes valid
(CON-003).

### `src/index.ts` and package exports

Purpose-specific package subpaths are good. Root wildcard re-exports make every
HTTP schema available but also eagerly evaluate every document. Runtime API
imports should use subpaths. Tooling that intentionally needs all documents can
use a dedicated `./artifacts` export or script-local import (CON-006).

The package-contract test checks only a subset of source files for Node imports;
all current production files were manually checked in this audit and remain
browser-safe. Generate this boundary check from the complete export/source map
so new domains cannot escape the test list.

## Tests, coverage, artifact validation, and CI

### Existing test quality

Tests cover the central runtime schemas, secret-free response shapes, exact
header/route metadata for the earlier domains, RFC 9457 reuse, artifact byte
identity, ETags, hostile deep graph input, schedule recurrence, webhook replay
secret suppression, and browser dependency boundaries. They are fast and
mostly behavior-oriented.

Twenty tests are too coarse for 18 source modules and seven public domains.
Module evaluation yields 94.16% statement coverage, but branch coverage is only
48.57%; the percentage shows why statement-only comfort is misleading. Missing
tests include structural OpenAPI validation, resolvable references, Zod versus
JSON Schema acceptance corpora, controller-route/status/header parity,
status/event state combinations, all credential control bytes, graph schema
projection, and generated-client consumption.

### Required contract gates

Add the following independent gates:

1. validate every OpenAPI document structurally with a pinned OpenAPI 3.1
   validator;
2. bundle/dereference every document and fail any unresolved reference;
3. compile generated JSON Schemas with a draft-2020-12 validator;
4. run shared accept/reject examples through Zod and generated JSON Schema,
   explicitly documenting runtime-only refinements/transforms;
5. compare documented routes, methods, status codes, parameters, security, and
   content types with Nest controller metadata/integration responses;
6. generate a typed client from each document and compile a smoke consumer;
7. enforce package branch/risk coverage.

CI currently runs package tests in the core matrix and `contracts:check` in the
quality job. It does not run any OpenAPI validator or contracts package coverage
threshold. Therefore current CI can be green with structurally invalid public
artifacts (CON-003).

## Plan and standards compliance

| Requirement | Assessment |
| --- | --- |
| Browser-safe shared contract package | Satisfied |
| Zod validation at HTTP seams | Satisfied in API runtime |
| One authoritative workflow graph schema | Source ownership satisfied; generated projection empty |
| RFC 9457 stable problem shape | Runtime shape exists; schedule/webhook artifacts do not reference it |
| Secret-free public responses | Generally satisfied |
| Explicit idempotency/CSRF/ETag seams | Runtime schemas/controllers strong; schedule/webhook docs incomplete |
| Deterministic committed client/OpenAPI artifacts | Byte determinism satisfied |
| Valid OpenAPI 3.1 artifacts | Not satisfied |
| Client schemas semantically represent runtime contracts | Not satisfied for graph and refinements |
| Contract/controller drift prevention | Partial manual assertions only |
| Public contract coverage in CI | Unit tests run; risk coverage and structural lint absent |

The package placement and plan are correct. The main failure is confusing
deterministic artifact generation with valid, behaviorally equivalent contract
generation.

## Findings and required remediation

### CON-001 — Four OpenAPI and two client-schema documents are structurally invalid

- **Severity:** P1
- **Classification:** Confirmed public-contract defect
- **Evidence:** minimal Redocly validation reports unresolved references in
  node-testing/workflow-authoring OpenAPI and forbidden Response Object
  `status` fields in schedules/webhooks; total OpenAPI structural errors: 85.
  A fresh whole-document resolver also found the same 15 node-testing and 40
  workflow-authoring unresolved references in the corresponding client-schema
  documents.
- **Impact:** code generators, documentation tools, and validators cannot safely
  consume the published specifications.
- **Remediation:** hoist/remap Zod definitions into document components; rebuild
  schedules/webhooks through the shared valid builder; remove invalid fields;
  define every path parameter.
- **Verification:** pinned OpenAPI 3.1 lint, bundle/dereference, and typed-client
  generation all pass for all seven documents.
- **Status:** Fixed.

### CON-002 — Generated workflow graph schema is empty

- **Severity:** P1
- **Classification:** Confirmed public-contract defect
- **Evidence:** generated save request contains `graph: {}`; graph shape and
  limits are absent.
- **Impact:** clients accept arbitrary data and cannot implement the promised
  shared editor/server contract.
- **Remediation:** expose/generate the recursive structural schema separately
  from custom preflight, attach limit metadata, and keep differential fixtures
  against the authoritative parser.
- **Verification:** generated schema contains recursive node/edge/settings
  structure and passes exact/one-over browser/server parity tests.
- **Status:** Fixed.

### CON-003 — CI checks artifact sameness, not validity

- **Severity:** P2
- **Classification:** Continuous-control gap
- **Evidence:** `contracts:check` compares bytes only; CI has no OpenAPI,
  dereference, JSON Schema, or generated-client gate.
- **Impact:** invalid or semantically empty documents merge while all repository
  checks pass.
- **Remediation:** add the pinned gates listed above to `contracts:check` and CI.
- **Verification:** corrupt reference, invalid response field, and empty critical
  schema mutations each fail CI.
- **Status:** Fixed; continuous gate.

### CON-004 — OpenAPI assembly is repeated and has drifted into two implementations

- **Severity:** P2
- **Classification:** Maintainability/architecture defect
- **Evidence:** five files copy the same primitives; two later files use a
  separate skeletal shape. Seven real callers justify one internal Adapter.
- **Impact:** security, errors, parameters, schemas, and versions drift by
  feature phase.
- **Remediation:** centralize typed OpenAPI primitives and a domain registry;
  keep route declarations domain-local.
- **Verification:** duplication ratchet decreases and all domains share one
  structural gate without losing readability.
- **Status:** Fixed.

### CON-005 — Generated schemas omit bounded JSON and runtime refinements

- **Severity:** P2
- **Classification:** Confirmed semantic projection gap
- **Evidence:** graph/bounded-input constraints and credential header
  super-refinements are absent from artifacts.
- **Impact:** generated clients disagree with runtime on security- and
  resource-relevant inputs.
- **Remediation:** represent what JSON Schema can express, add explicit
  extensions/descriptions for runtime-only constraints, and maintain a shared
  behavior corpus.
- **Verification:** Zod/JSON Schema differential tests categorize every
  intentional difference.
- **Status:** Fixed.

### CON-006 — Root imports eagerly construct every contract document

- **Severity:** P2
- **Classification:** Performance and Interface-depth improvement
- **Evidence:** root import used roughly 14.5 MiB heap versus 3.5 MiB for a
  narrow schema import on the audit host; API has several root imports.
- **Impact:** avoidable API startup/memory cost and cross-domain coupling.
- **Remediation:** migrate runtime imports to subpaths and isolate artifact
  aggregation behind a tooling-only entry.
- **Verification:** import graph and cold-start/heap comparison; package boundary
  test forbids application root imports.
- **Status:** Fixed.

### CON-007 — HTTP credential values admit invalid control bytes

- **Severity:** P2
- **Classification:** Input-boundary defect
- **Evidence:** schema accepts C0 bytes other than NUL/CR/LF and DEL.
- **Impact:** persisted credentials can fail or behave inconsistently at the
  HTTP transport boundary.
- **Remediation:** enforce the supported RFC field-value byte set in both public
  and resolved credential schemas.
- **Verification:** exhaustive byte table through contract, encrypted round
  trip, and real Node transport.
- **Status:** Fixed.

### CON-008 — Public state/result schemas admit contradictory combinations

- **Severity:** P2
- **Classification:** Contract-modeling improvement
- **Evidence:** lifecycle, preview, run/node, event, and webhook command schemas
  are flat with independent optional fields.
- **Impact:** generated types do not make invalid states unrepresentable and
  clients require defensive interpretation.
- **Remediation:** use discriminated unions for stable state-specific
  invariants, especially credential disclosure and event payloads.
- **Verification:** exhaustive valid matrix plus impossible-combination
  rejection, aligned with database/API producers.
- **Status:** Fixed.

### CON-009 — Contract package has no risk-coverage threshold

- **Severity:** P2
- **Classification:** Continuous-control gap
- **Evidence:** 48.57% audit branch coverage; no package coverage script or root
  coverage inclusion.
- **Impact:** critical schema alternatives/refinements can regress under green
  statement-heavy tests.
- **Remediation:** add branch-focused V8 coverage and a risk manifest for
  projection/contract seams.
- **Verification:** CI threshold and mutation cases for unions/refinements.
- **Status:** Fixed; continuous gate.

### CON-010 — Problem code/status/type mapping has no single manifest

- **Severity:** P3
- **Classification:** Maintainability improvement
- **Evidence:** code enum, API filter mapping, OpenAPI response names, and
  schedule/webhook manual codes are independently maintained.
- **Impact:** a code can be documented with the wrong status/type or omitted.
- **Remediation:** create one browser-safe bounded manifest consumed by schema,
  filter assertions, docs, and telemetry.
- **Verification:** every emitted application error maps exactly once.
- **Status:** Fixed.

### CON-011 — Alias, list-bound, export, and artifact registries need cleanup

- **Severity:** P3
- **Classification:** Maintainability improvement
- **Evidence:** multiple exact schema aliases, an unbounded destination list
  despite a database limit of 100, manual artifact enumeration, and a partial
  browser-boundary source list.
- **Impact:** wider Interface and several easy drift points.
- **Remediation:** keep demonstrated aliases, share list constants, generate
  artifact/export checks from one registry, and inspect every exported source.
- **Verification:** consumer search, export snapshot, exact list-limit tests,
  and registry completeness test.
- **Status:** Fixed.

## What should remain unchanged

- Keep contracts browser-safe and free of NestJS/database/provider dependencies.
- Keep workflow-model as graph owner; do not fork its schema by hand.
- Keep runtime Zod validation even after generated-schema validation.
- Keep opaque ETags/cursors/idempotency values and strict request objects.
- Keep secrets out of connection, trigger health, preview, event, and problem
  responses.
- Keep deterministic committed artifacts and byte-drift checking as one gate.
- Keep domain route declarations readable; centralize primitives, not product
  meaning.

## Recommended implementation order

1. repair unresolved/invalid OpenAPI output and add structural lint/bundling
   (CON-001, CON-003).
2. publish the real graph schema and bounded/refinement semantics (CON-002,
   CON-005).
3. consolidate OpenAPI generation and migrate schedules/webhooks (CON-004).
4. fix credential bytes and public state unions (CON-007, CON-008).
5. remove eager root runtime imports and add risk coverage (CON-006, CON-009).
6. unify problem metadata and clean small registry/alias/bound issues (CON-010,
   CON-011).

After remediation, run build, typecheck, lint, package tests, risk coverage,
artifact byte check, OpenAPI lint and bundle, JSON Schema compilation,
generated-client smoke compilation, controller parity/integration tests, and the
whole pre-push gate.
