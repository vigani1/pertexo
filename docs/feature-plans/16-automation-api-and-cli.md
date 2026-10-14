# F16 — Scoped automation tokens, public API and CLI

Status: owner authorized planning, review and implementation on 2026-10-14,
after F09 and F24. Parent: [product roadmap](../product-roadmap.md).
Decision: [ADR 074](../adr/074-personal-automation-tokens.md).

## Outcome and scope

A workspace member creates an expiring personal API token in Settings, saves its
secret once, and uses documented workflow/run operations from a script or the
existing CLI. It grants an explicit subset of that member's current permissions
in exactly one workspace. Browser sessions retain their existing behavior.

Include token creation/list/revocation, workflow list/read/draft/version listing,
run start/list/read/cancel, portable export/import preview/apply, publication,
and an HTTP CLI for those operations. Imports retain F05's exact reviewed-source,
connection-binding, checksum and precondition rules. Exclude credential/account/
team administration, editor mutations, recovery/replay, triggers, streaming events
and internal operator commands.

No service accounts, OAuth server, JWTs, SDK package, CLI profile format, new role,
service, external dependency or CI job. Keep seams for later requirements
rather than building speculative infrastructure: these additions fail the two-question test.

## Reconciled foundations

Baseline main: `cea7772e3154b23f164e95a38cad71256c759d1f`, after F24 #281.
Natural main CI, CodeQL and ARM publication succeeded. F09 #273–#278 and F24
#279–#281 are complete; F24 file conversion remains separately gated on F04.

- `api/src/workspaces/http/guards.ts` owns cookie authentication, CSRF and
  capability guards. Tokens need a distinct credential adapter, never fake sessions.
- `api/src/authorization/` shares role checks and issues guard proofs. Scope
  intersection belongs here, including capabilities requested inside import.
- `database/src/tenant-access/` owns identity/membership. Existing membership
  `role_revision` advances on role/status, leave/removal and ownership changes.
- Current authoring, publication, portability and run use cases own operations.
  Extend their authentication adapters rather than duplicate business rules.
- Existing receipts, forced workspace RLS, three database roles, reader fences,
  audit facts, retention and purge remain the infrastructure owners.
- `apps/ops` currently requires privileged operator/database configuration. Its
  new HTTP command path must dispatch before operator configuration and imports.

Paths above abbreviate `apps/` and `packages/`; implementation uses their current
owners, not new parallel facades.

## Accepted product and security choices

### Personal ownership and scopes

Active members manage only their own tokens. Available scopes are limited to
capabilities currently held. No administrator impersonation or new token role.
Reuse capability names: `workflow:read`, `workflow:create`, `workflow:publish`,
`run:read`, `run:start`, `run:cancel`, `connection:read`. The last only permits
explicit import binding resolution; it does not expose connection routes/secrets.
Starting a published workflow retains its existing authority to execute pinned
connections. Scopes do not imply each other; examples state prerequisites and
shared use cases enforce each capability they need. Run workflow-name projections also require workflow:read on the token. Current
run responses have no action flags to extend; replay/recovery endpoints stay
cookie-only rather than acquiring invented response controls.

Store membership revision at issuance. Every authentication checks digest,
expiry/revocation, active owner, active membership, equal revision and active
workspace. Current role checks still apply. Role upgrades cannot expand an old
grant; suspension/reactivation, removal/rejoining or transfer cannot revive it.
Metadata explains membership invalidation. Logout/password changes do not rotate
API tokens; document their independent lifecycle and explicit revocation.

Default expiry: 30 days; choices 1–365 days, no unlimited expiry. Bounded plain
names; at most 10 usable tokens per owner/workspace under the membership lock.
Expired/revoked/invalid tokens do not count. Paginate metadata. Rotation means
create replacement, update script, revoke old token; no mutable secret subsystem.

Creation requires existing recent-sign-in evidence within the current five-minute
bound. Management stays cookie-only,
with current CSRF and ownership checks. Creation/revocation use stable command
keys and identifier-only receipts. Revoke is idempotent. Lost creation responses
are recovered through metadata and explicit revoke/replacement, not secret replay.

### Credential and transport

Issue 32 cryptographically random secret bytes in:
`ptx_1.<workspace UUID>.<token UUID>.<base64url secret>`.
Public IDs permit workspace-scoped lookup but confer no authority. Parse its
exact bounded shape once at authentication, SHA-256 the complete credential,
compare fixed-length digests in constant time. Store only hash and metadata;
no encryption master key, pepper, raw secret in receipts/audits or recovery API.

First creation returns the raw secret with `Cache-Control: private, no-store`.
Command replay returns metadata and explicit secret-unavailable outcome, never
regeneration. List/restore cannot retrieve it. Auth errors never reveal whether
an owner/token exists.

Accept exactly one Authorization Bearer header only on explicitly enabled
methods. Reject malformed/repeated headers and mixed session/bearer credentials;
never cookie fallback after bearer failure. All other methods stay cookie-only
and reject bearer attempts. No body/query/URL credentials. CSRF exemption requires
successfully verified machine authority on an enabled method, never header presence.
Actor/proof types bind credential kind, owner, token ID/scopes, workspace and
request; session IDs and token IDs are distinct.

Invalid/revoked/expired tokens return generic 401 plus Bearer challenge. Scope
failures follow current 403/404 disclosure policy. Validation, response schemas,
problem contracts, preconditions and cancellation remain shared.

Each request checks PostgreSQL; no auth cache. Verification is the revocation
linearization point: previously verified requests may finish; verification after
revocation commits fails. Accepted runs continue under durable execution authority.
Do not add request-wide transactions or automatic run cancellation.

Reuse distributed rate limiting: retain IP, owner and workspace budgets and add
verified token identity as a subject dimension. Multiple tokens cannot bypass the
owner budget. The bearer guard consumes a dedicated `automation_authentication` IP budget
(600 attempts/minute, closed on limiter failure) before credential lookup,
using the existing distributed limiter; the interceptor runs too late for denials. No untrusted token IDs
in trusted actor buckets or high-cardinality metric labels. Last-used is approximate
successful authentication, written at most once/minute/token using the database
clock, without an authority cache.

Remote access requires HTTPS; HTTP only for loopback development. Never log/trace
Authorization values, secrets, hashes or secret-bearing creation bodies. Problems,
audits, CLI diagnostics and screenshots remain sanitized.

### Supported HTTP methods and command identity

Existing paths under `/v1/workspaces/:workspaceId`, existing contracts:

| Methods | Scope | Owner |
| --- | --- | --- |
| GET workflows, workflow, draft, versions | workflow:read | workflow-authoring/http |
| POST workflow/export | workflow:read | workflow-authoring/portability |
| POST workflows/import/preview, import | workflow:create; connection:read with bindings | workflow-authoring/portability |
| POST workflow/publish | workflow:publish | workflow-authoring/http |
| POST workflow/runs | run:start | workflow-runs/http |
| GET runs, run | run:read | workflow-runs/http |
| POST run/cancel | run:cancel | workflow-runs/http |

Add browser-only GET/POST `api-tokens` and POST `api-tokens/:tokenId/revoke`.
Sanitized public schemas cover metadata/status, scopes and creation outcomes.
OpenAPI advertises cookie/bearer alternatives only on supported methods and
management's real cookie/CSRF requirements, headers and errors.

Preserve caller Idempotency-Key, reviewed import digest and opaque If-Match.
Namespace the stored receipt scope by verified token ID through one shared
helper, using a fixed-length canonical hash. Keep the original command key: hashing
only that key would let a session deliberately imitate its value. Session command identity stays
unchanged. Same token/key/payload replays; changed intent conflicts. Another token
or session cannot discover/reuse that receipt. Retries do not rewrite bindings,
source references or preconditions.

## Structure and storage

| Owner | Responsibility |
| --- | --- |
| contracts/src/schemas/identity/ | Browser-safe schemas/scope source; OpenAPI registration |
| database/src/schema/identity/api-tokens.ts | Single table definition: owner/workspace, digest, scopes, membership revision, expiry/revocation/last-use |
| database/src/tenant-access/tokens/ | Typed lifecycle/lookup policy and credential helpers through existing tenant-access entry point |
| database/migrations/ | Next additive migration/snapshot, forced RLS, least grants, unchanged three roles |
| database/src/lifecycle/ | Bounded retention and purge before memberships; safe receipt cleanup |
| api/src/authentication/automation/ | Bearer parsing/authority/guard, separate from Better Auth |
| api/src/authorization/ | Discriminated credential actor, scope intersection/proof binding |
| api/src/api-tokens/ | Management module/controller/use cases/errors |
| existing API HTTP owners | Method-specific opt-in and command identity; shared use cases |
| web/src/features/api-tokens/ | Local data/form/page/list/one-time receipt and deliberate public entry |
| web/src/routes/workspace/ | Lazy Settings composition/navigation |
| cli/src/ | Argument parser, HTTP transport/commands; independent of operator config |

Use current owners when inventory names differ and record corrections. No empty
folders/facades, duplicated types, consumer barrels or browser database imports.
Keep directories near ten files; names describe responsibilities. Pure moves need
separate buildable commits.

Creation locks workspace → user → membership in existing order, checks authority/
limit and writes token/audit/receipt atomically. Revoke checks the owning authority
and token. Runtime lookup sets workspace from the validated credential, retaining
forced RLS and current roles. Composite tenant identities/constraints prevent
cross-workspace ownership. TypeScript owns permission rules; SQL owns isolation,
constraints, atomic writes/locks and timestamps, not permission functions/triggers.

Clean expired/revoked/inactivated metadata after 30 days using the existing bounded
retention coordinator; do not introduce a legal-hold subsystem. Purge tokens before memberships; existing
audit scrubbing remains. Restart/restore proves hashes authenticate and revoked/
expired credentials stay unusable. Only disposable databases receive migrations.

## Web and CLI behavior

Keep Weft, semantic Status, plain forms and existing accessible dialogs. Settings
API tokens belongs to the selected workspace/person. Show name/scopes/expiry/
approximate last use and active/expired/revoked/membership-changed status. Creation
has permitted scope checkboxes, expiry, recent-sign-in handling and one-time Copy/
Done receipt. Warn to save before closing; closing clears component-local secret.
Never put it in query/global mutation cache, localStorage or URLs: feature-local
API returns directly to component state; refresh metadata only. Lost outcomes
show refresh/revoke/replacement, not automatic recreation. Disabled config explains
availability rather than claiming the member lost access.

CLI uses native fetch and current contract parsers in apps/ops, through direct
references to the existing contracts/workflow-model workspace packages. `automation`
arguments dispatch before operator env/DB imports. Use PERTEXO_API_URL,
PERTEXO_API_TOKEN and explicit workspace/IDs, no token argument or saved profiles.
Bound files/requests/responses/timeouts; refuse unsafe remote HTTP and redirects.
No arbitrary raw endpoint passthrough, cookies, secret output or hidden DB env.
Output contract-validated JSON; safe errors include code/request ID/detail only.
Document workflow list/get/draft/versions, run start/get/list/cancel, export,
import-preview/import and publish, with curl equivalents. Where the existing endpoint requires a command key, mutations require a stable
explicit key; cancellation retains its existing state-idempotent contract.
Uncertain writes never retry with new keys. Import/publish
preserve reviewed source and ETag. Examples explain secure storage and replacement.

## Ordered delivery and acceptance

0. **Plan PR:** accepted ADR 074, glossary, this manually reviewed plan and F24
   completion evidence. Required repository lint/types/unit gates before commit.
1. **Token/API PR:** additive schema/lifecycle, contracts, management, actual
   bearer verification, shared scopes, selected methods, rate limits/idempotency
   and OpenAPI. Usable HTTP behavior; no placeholder web controls. Real isolated
   PostgreSQL/Redis API/worker qualification plus schema/contract/architecture
   checks and existing cookie regression cases.
2. **Settings PR:** one-time creation, metadata, revoke/replacement. Build/lint/
   types/unit, full mocked e2e, changed-code React Doctor, real owned-fixture
   browser/API/database journey at desktop and 375px reduced motion. Synthetic
   screenshots only; live credential/auth traces/screenshots disabled.
3. **CLI/docs PR:** real HTTP commands and user guide. Against owned API/worker:
   export → preview → import → reviewed publish → start → completed run; separate
   SQL checks immutable source, receipts and outputs. Token denial and existing
   operator regressions. Real Settings create → CLI use → revoke → CLI denial.

Each slice: one PR, green required CI/rebase merge before next; inspect natural
main CI/CodeQL/ARM. Track actual evidence, not code availability.

Required cases across slices:

- Malformed/repeated/mixed headers, cross-workspace/hash/expiry/revocation,
  unsupported methods, cookie fallback and CSRF. Exact scopes on every allowed
  method, including import's additional capability and forged/swapped proofs.
- Owner/member/workspace current state; upgrade/downgrade, suspend/reactivate,
  removal/rejoin and transfer never revive/escalate. Concurrent token cap, ordered
  issuance/revoke/membership races and denial after committed revocation.
- Secret once; lost response/creation replay and wrong-owner listing safe.
  No secret/hash in receipts/audit/logs. Persistence/restart, bounded last-use,
  retention/purge, forced RLS and three-role grants. Rates retain owner budgets.
- Command identity across tokens/sessions, changed-intent conflicts, reviewed
  source/ETag retries and existing session behavior preserved.
- Mobile keyboard/focus/copy/close and uncertain outcomes. CLI bad URL/redirect,
  oversize/timeout/non-JSON/malformed responses fail safely without DB prerequisites.

## Rollout, rollback and plan review

AUTOMATION_TOKENS_ENABLED follows existing configuration patterns. Explicitly
enable in development/beta examples after migration. Disabled state stops issuance/
bearer auth but preserves metadata/revocation and browser auth. No new flag service.

Respect reader-head fences: hold traffic, existing backup, additive migration,
matching API/worker readers/writers, then enable. Old binaries may refuse the new
head; rollback disables tokens and retains compatible readers, not a destructive
schema downgrade. Backup preserves hashes, cannot recover raw secrets; scripts
keep their credential separately. No deployment/accounts/provider calls here.

Manual review: personal ownership, revision reuse and shared roles avoid new
identity machinery; method opt-in prevents accidental administration access;
identifier-only receipts make one-time disclosure honest; the existing CLI avoids
a new app/package. Revocation allows already accepted work, last-used is approximate,
and membership changes deliberately require replacement. These are supported
semantics. No independent requirement justifies service accounts, caches or SDKs.

Primary references checked 2026-10-14:
[RFC 6750 bearer usage](https://www.rfc-editor.org/rfc/rfc6750),
[OWASP REST security](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html),
[OWASP logging](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html).
These inform transport/authorization/redaction, not an OAuth subsystem.

## Tracker

- [x] Owner authorized F16 after completed F09/F24.
- [x] Baseline/current owners/membership epoch reconciled; plan manually reviewed.
- [x] Slice 0: PR #282 merged after all required checks; natural main
  `38509c60e08076b67fa87f7f4d01dac53de16095`, CI 38521325955, CodeQL
  38521325982 and ARM publication succeeded.
- [x] Slice 1: PR #283 merged; natural main
  `b8f9d1b38e6e24241a941f80dfce49988a351383`, CI 38543579563 (including ARM)
  and CodeQL 38543579596 succeeded.
- [x] Slice 2: PR #285 merged; natural main
  `66aea767517041397cef6796b541b3448d4e5893`, CI 38554451783 (including ARM)
  and CodeQL 38554451846 succeeded.
- [x] Slice 3 CLI/API/worker qualification and user guide implemented and locally
  verified. [Delivery PR #286](https://github.com/vigani1/pertexo/pull/286) records
  required CI, merge and natural main qualification.

Release acceptance remains green required CI and CodeQL, rebase merge, then
inspection of natural main CI/CodeQL/ARM. Record those run IDs on the delivery PR
so this source snapshot does not claim future checks already passed.

### Slice 1 qualification

Backend implementation merged in PR #283. Migration 0006 adds the token table, forced RLS and least grants and
accepts the planned token receipt namespace in manual-start rejection storage.
The table sits under `schema/identity/` to keep the schema root from growing
further. Database reuses the existing contracts package for one schema/scope
source; no external dependency is added.

Eight real disposable-PostgreSQL cases check one-time disclosure, safe receipts/
audits, restart, bounded last-use, revocation, owner isolation, role changes back,
12 concurrent creations at the ten-token cap, pagination, expiry, maintenance
retention, suspension/reactivation, ownership transfer, bounded workspace purge
before memberships with audit scrubbing, direct forced-RLS reads and denied
digest mutation through the app role.
Three real API cases use ordinary sign-up/verification/sign-in and published
pure Set workflows: eligible reads, publish/retry, start/retry, cancel, reviewed
export/preview/import/retry, separate token/session receipts, version conflict,
mixed/invalid credentials, unsupported routes, revoke and plain disabled-server
availability. Existing real invitation/membership journeys also pass. These
fixtures own their databases; the owner's application data/services are unchanged.

Shared authorization tests bind scope and credential proofs. Import with explicit
bindings requires the token's additional connection:read before persistence.
Authentication admission protects lookup by IP and fails closed; post-authorization
quotas retain owner/workspace budgets and add token identity. Existing limiter
failure/metric tests pass. The five-minute sign-in policy is shared with ownership
transfer. Bootstrap and resource cleanup regression tests pass with the token
store and shared limiter owned by their existing runtimes.

Contracts/OpenAPI advertise bearer authentication only on enabled methods; cookie
CSRF remains required while bearer requests do not use it. Disabled authentication
and issuance answer a plain availability problem; listing/revocation remain.
The beta Compose configuration forwards the switch only to API, and existing
KMS/self-managed plus Resend/SMTP credential-isolation qualifications pass.

Local repository checks pass (format, build, lint, TypeScript, unused exports,
contracts, schema ownership and source boundaries). Full unit suites pass,
including API 1,981 and database 536 tests. The broader database integration
suite passes 749 cases (46 environment-gated cases skipped); it includes the
existing inherited-JSON-hook fence. Token scope persistence reuses the database
serializer so schema setup and writes do not invoke inherited toJSON hooks.
CodeQL identified public actor/command metadata as possible password data. The
automation actor now explicitly projects public identity fields and immutable
scopes, and operation labels are attached to command metadata at the call site.
Tests prove secret/digest fields cannot enter that actor. No query is suppressed,
no algorithm is weakened and existing receipt bytes remain identical.
The API fixture checks accepted/cancel-requested runs without a worker; completed
worker execution remains explicitly required in slice 3. All required PR and
natural main checks passed, including the final CodeQL security gate and ARM
publication. Settings and the CLI remain the next slices.

### Slice 2 qualification

Settings uses a lazy feature-owned page, scoped metadata queries, one-time local
secret state and the existing Weft/accessible primitives. Recent sign-in returns
to an explicitly allowlisted token page. Creation never enters a query/mutation
cache or retries automatically after an uncertain response. Revoke preserves its
key for exact retry; its metadata mutation owns authoritative cache updates and
invalidation. Lists retain previous cursor pages and explain membership/expiry,
disabled servers and replacement.

Nine focused unit cases cover disclosure/cache absence, duplicate submission,
unmount/abort, lost/replayed creation, recent sign-in, disabled issuance, exact-key
revoke retry, pagination and redacted credential diagnostics. Four mocked browser
cases cover desktop and 375 × 768 reduced-motion use, real permitted clipboard
copy, focus restoration, scrolling, long names and disabled-server revocation.
The default denied-clipboard run showed the existing manual-selection fallback;
permitted copy was checked against the synthetic exact value.

A real owned PostgreSQL/Redis/API/worker/browser fixture passes ordinary public
sign-up/sign-in, UI creation and revocation at both widths, cookie-free bearer
reads, unsupported management and ungranted import denial, and refusal after
revoke/reload. Independent SQL checks hashes, ownership, membership revision,
last use, revoked state and identifier-only receipts/audits. No credential is
posted as evidence. Transient receipt/request failures are rethrown without
Playwright call logs or matcher snapshots; live traces/screenshots remain off.

Native HTTP qualification exposed Node discarding repeated Authorization values
from normalized headers. Authentication now checks the original header count;
the regression goes from 200 to 401. All three real token API cases pass with
API_IDENTITY_INTEGRATION explicitly enabled, plus the original header/cookie
regressions. No schema, role or new CI job is added: the existing browser loop
includes the new case. React Doctor after the ownership/composition fixes is
100/100 with no suppressed rules. Full repository gates and sequential units
passed (web 1,152, API 1,982, worker 720, database 536); all 157 mocked browser
cases passed. The final owned live journey passed after original-header
hardening. Three synthetic review images were inspected at desktop and phone
widths. All required PR and natural main checks passed, including CodeQL and ARM
publication. CLI and completed-worker qualification remain the final slice.


### Slice 3 qualification

The existing ops app dispatches `automation` before loading operator configuration,
database clients or telemetry. Its feature directory owns named argument decoding,
bounded file/HTTP transport, shared-contract command mapping and safe process output.
It reuses the existing contracts/model workspace packages, with matching project
references; no external dependency or profile/storage format is added.

All twelve commands preserve the caller’s reviewed files, original command keys,
compatibility fingerprint and opaque ETag. Draft CLI output adds its validated HTTP
ETag as command metadata. Native HTTP refuses redirects/cookies/unsafe remote HTTP,
bounds regular UTF-8 JSON files/requests at 2 MiB, responses at 16 MiB and requests
at 30 seconds. Invalid/lost write responses report unknown outcome without retry.
Export/import preview remain reads despite using POST; cancellation keeps its
existing state-idempotent contract. Credential material in bodies or response ETags
is refused before output; raw exceptions/headers are never diagnostics.

The ops suite passes 119 cases, including all 55 existing operator cases. New
behavior checks cover twelve command mappings, validation/preconditions, exact
headers/bodies, URLs, duplicate/irrelevant flags, files/FIFOs/size/UTF-8, bounded
response streams, invalid JSON/problems/credential echoes, deadlines and interruption.
A native server proves redirects are never followed. Compiled child processes run
with only URL/token environment and handle failures/SIGTERM without database or
telemetry prerequisites. Both documented JSON preparation commands ran successfully
with disposable files.

The existing owned browser/API/worker scenario retains desktop and 375px reduced
motion token journeys, and adds ordinary UI issuance → compiled CLI export →
preview → import/retry → review unpublished copy → publish/retry → start/retry →
succeeded run → UI revoke → CLI 401. Independent SQL checks identical source/copy
graphs, one immutable copy version, one run, its actual step output, exact original
command-key hashes and credential-scoped receipts. Completed-run cancellation is
correctly refused. Evidence contains only public identifiers; live traces/screenshots
remain disabled and transient credentials stay local to the owned journey.
The receipt verifier now uses the actual `workflow.run.accept` operation name.
All three real token API cases pass with their integration flag explicitly enabled.

Repository-wide format/build/lint/types/dependency/contracts/schema/architecture
checks pass. Sequential unit suites pass, including web 1,152, API 1,982, worker
720, database 536 and ops 119. The final owned live journey passed after transport
privacy hardening. The [automation guide](../automation.md) documents all commands,
curl equivalents, scoped ownership/expiry/replacement, safe environment storage,
reviewed digest/ETag/body preparation, paging, cancellation and exact retry rules.
PR and natural main checks remain the release gate recorded on the delivery PR.


The existing browser CI build step includes the compiled ops app and its dependency
closure; the live fixture verifies that binary without credentials before issuance.
Its missing-build regression fails plainly before opening a receipt. CI also exposed
an older Call recovery test polling a transient pending state while live workers
could finish it. That fixture now uses the existing queue recovery harness to
complete Manual and Call preparation and persist the intent before action redelivery.
It retains real stores/workers, identity/receipt-expiry assertions and original
timeouts, with no production hooks or added retries. Local Call integration and
browser/CLI qualifications pass after these fixes.


## Owner-approved CLI separation — 2026-10-14

Move the seven HTTP CLI files from ops into `apps/cli/src/`, with their four
behavior-test files in `apps/cli/test/`. Relocate its existing compiled bootstrap
and dependency/build/test/image references in a move-only commit. Keep the
existing automation argument prefix in that intermediate commit so the relocated
compiled-process tests retain identical invocation behavior. No app-to-app imports
or temporary dependency exceptions. Ops retains only its operator bootstrap and
maintenance-database/observability dependencies.

A separate wiring commit will expose the dedicated CLI entry point/root script,
update the guide and ADR 074, and enable the existing automation switch in the
beta production example. Commands, flags and output contracts stay the same;
only their launcher changes. The CLI has contracts/model/zod dependencies and no
database, maintenance or telemetry configuration. Prepare its private package's
bin/files/Node engine shape, without npm publication, a new service or CI job.
Existing CI app tests/browser build and the existing image carry the moved app.

- [x] Move HTTP CLI source, tests and bootstrap; update dependency/build ownership.
- [ ] Wire standalone entry/root script, private package shape and beta switch.
- [ ] Update guide/ADR and qualify compiled CLI plus existing operator commands.
- Merge only after the existing required checks pass; record release evidence on
  the delivery PR. Historical slice 3 evidence above describes its original ops
  location and is superseded by this follow-up for current ownership.
