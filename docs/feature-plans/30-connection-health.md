# F30 — Connection health and reconnection

Status: first Slack slice implemented and qualified locally; independent review and release pending.
Created: 2026-09-29. Parent: [product roadmap](../product-roadmap.md).
Scope: Extends existing connections. Relative size: **M–L**, not a calendar estimate.

## Outcome

People learn that a connection stopped working (revoked, expired or rejected
credentials) before more runs fail, see which workflows depend on it, and fix
it in one place.

## Current implementation and evidence

The accepted planning baseline was: connections record `lastTestedAt`, `lastHealthyAt` and `lastErrorCode`, and
people can test and rotate them. Production runs do not currently report health.
An internal bounded `findConnectionImpact` projection already indexes published
version usage; there is no user-facing used-by endpoint. Reuse that projection.
The standalone health writer is not a safe worker integration: it lacks a
secret-version fence, sets test timestamps for every source, and does not
restore active status on success. Manual-test completion fences the secret
version, but claim/resolution/dispatch currently prevent testing a
reauthorization-required connection, and concurrent same-version tests lack an
ordering fence. Rotation currently preserves old health timestamps. These are
explicit first-slice corrections, not evidence that recovery already works.

Inspected anchors (paths may move):

- [packages/contracts/src/http/connections.ts](../../packages/contracts/src/http/connections.ts)
- [docs/adr/023-slack-send-message-provider.md](../adr/023-slack-send-message-provider.md)
- [accepted-completion health persistence](../../packages/database/src/execution/node-attempts/node-attempt-connection-health.ts)
- [connection test persistence](../../packages/database/src/connections/connection-test-persistence.ts)
- [published usage projection](../../packages/database/src/connections/workflow-integration-usage.ts)
- [attempt dispatch](../../packages/database/src/execution/node-attempts/node-attempt-run-store-dispatch.ts)
- [attempt completion](../../packages/database/src/execution/node-attempts/node-attempt-run-store-completion.ts)

## Dependencies and planning gate

None to start. F27 turns health changes into notices; F26 may pause workflows
whose connection is broken.

Resolved in [ADR059](../adr/059-connection-health-observations.md) before code:

- **Authoritative signals**: only provider responses that mean the credential
  is invalid (for example revoked or unauthorized) change health; timeouts and
  rate limits never do. One failed request is not enough unless the provider
  says so definitively.
- **States**: reuse the existing connection status `reauthorization_required`
  for credentials a provider rejects, beside test-derived health; transitions
  are recorded with time and a safe reason code, never provider error text or
  secrets.
- **Recovery**: a current successful test restores health; run success is
  positive evidence only if no newer health transition intervened. Rotation
  resets current-credential evidence to unknown. Normal workflow dispatch does
  not bypass a reauthorization-required state merely to test recovery.
- **Usage**: which published workflow versions reference a connection.

### First-slice authorization and ownership

The manager owns this plan and ADR059; the existing implementation chat owns
code, tests, evidence and coherent commits. Implement the full narrow vertical
slice below, not just a library. Automatic signals are Slack send-message only.
Existing manual testing for other providers remains supported; do not expand
automatic detection to generic HTTP/Resend/preview/notification traffic.

The manager's baseline is F29 reviewed head
`7561e82251762dd3b1e2f9f355f4a7376e331670`. F29 PR138 and natural main
CI/CodeQL passed; its queue-only slice merged as `02750811` and is qualified;
normal-merge its qualified main result when available, without rewriting history.
F30 has its own branch, review, PR, and exact-head/postmerge qualification.

## Implementation contract

### 1. Evidence production and delivery

- Share one provider-owned pure Slack health classifier between the real
  send-message adapter and Slack manual tests. Its closed rejection allowlist is
  `account_inactive`, `token_expired`, `token_revoked`; a parsed successful send
  is positive evidence. Generic 401/403, `invalid_auth`, `not_authed`, permission
  and channel failures, timeouts, rate limits, malformed responses, and local
  errors do not mark a connection broken. Preserve existing execution outcomes,
  error codes, retry policy and ADR023's unsafe-dispatch protection.
- Persist dispatch connection identity and health revision from the database,
  verifying the published slot binding, current secret version, provider/auth
  identity, attempt lease and workspace. Repeated marking is immutable. Carry
  only the small classified observation through the trusted execution runtime;
  do not return secrets/provider bodies in node output, logs or events.
- Accepted completion atomically persists the observation, its outbox command,
  normal attempt result and receipt. Identity is at most one observation per
  attempt for this one-slot provider. Duplicate completion compares evidence;
  stale leases, unmarked dispatch and mismatched duplicates cannot add evidence.
- Add one dedicated bounded health-application command to the existing typed
  job registry, durable outbox, worker dispatch, receipts and recovery. Payload
  contains identifiers only; the handler loads evidence. Database application
  serializes on the connection and applies ADR059's version/revision predicate.
  State update, single transition event and command receipt commit together.
  Stale evidence becomes an idempotent no-op with a safe disposition.
- A failed health command can be redelivered but cannot replay the provider,
  delay run advancement, or rewrite attempt/run truth. Preserve the existing
  completion-failure reconciliation contract. Do not swallow evidence-write
  errors as success or create a best-effort second write after completion.
- Reuse existing queue retry/dead-letter, dispatch acknowledgement and owned
  readiness patterns. Prove interrupted publish and worker restart recovery.
  Include observation rows/commands in workspace purge, attempt retention,
  restore, export/redaction and compatibility closure. Retain no credentials;
  retain evidence no longer than its source attempt and avoid dangling work
  during retention/purge. Late authorized delivery of purged evidence is a safe
  no-op, not an unconstrained mutation.

### 2. Health state and explicit recovery

- Add the health revision and the bounded current-credential health fields
  needed for the public read. Bind manual tests to that revision at dispatch.
  Apply the exact transition rules in ADR059; no timestamps-as-ordering logic.
- Allow manual testing of reauthorization-required connections through every
  existing layer, without allowing normal workflow dispatch or testing revoked
  connections. Preserve authorization, idempotency, CSRF, auditing, provider
  timeout and redirect restrictions. No new credential recovery endpoint is
  needed: reuse Test and Rotate.
- Preserve `lastTestedAt` as explicit-test time only. Rotation clears timestamps
  that would otherwise claim the new credential was tested/healthy, plus the
  current diagnostic. Do not erase historical test/audit events. An inconclusive
  test must not replace a definitive outstanding rejection reason.
- Close the old worker standalone-health capability. Database roles must not
  gain general connection writes; use narrowly scoped functions with fixed
  search path, workspace checks and source identity validation. API, worker,
  dispatcher and PUBLIC negative tests must prove the intended ACL matrix.
- Before implementing migrations, record lock order and mixed-version behavior.
  Do not edit published migrations. Add migration-plan/history/readiness proof
  for new columns, constraints, indexes, functions, policies and exact grants.
  Older workers that cannot produce/apply this evidence must not be advertised
  as an enforce-capable cohort. No ABI identity changes hidden in old manifests.

### 3. Authorized used-by read and frontend

- Add `GET /v1/workspaces/:workspaceId/connections/:connectionId/usage` using
  authenticated-read limits, `connection:read` plus `workflow:read`, active
  membership/workspace checks and normal non-disclosure semantics. No mutation,
  no graph bodies and no credential/secret-version metadata in the response.
- Return one row per retained published version with workflow ID/name/lifecycle,
  version ID/number, current-publication flag and sorted unique operation keys.
  Include archived workflows and historical versions with explicit labels;
  exclude draft-only references. Use an opaque connection/workspace-bound
  keyset cursor ordered by version identity, default 50 and maximum 100 rows.
  Validate stale/mismatched cursors through the existing cursor conventions.
  Join and page the existing usage projection; never load all graphs or all
  usage rows and slice in memory. Prove the query uses a bounded indexed path.
- Extend the existing safe connection response with clearly named run health
  and transition/source metadata where existing fields are insufficient. Keep
  the health revision and dispatch identity private. Generate contract/OpenAPI
  artifacts and browser-safe exports with the normal repository checks.
- On the connections surface show Unknown/Healthy/Needs reauthorization/Revoked,
  the safe reason, correctly labeled timestamps, the paginated used-by list,
  and existing permission-aware Test/Rotate actions. A recent test failure is
  not a provider-outage status page. Show automatic run coverage as Slack-only.
  Existing workflow settings connection rows can link to the same detail state
  without a second health implementation. Do not add enabled placeholder controls.
- Follow `apps/web/AGENTS.md`, README and ARCHITECTURE; reuse feature public
  interfaces and TanStack Query snapshots. Bound refresh while visible; cancel
  requests and evict scoped caches on permission/session/workspace loss. Held
  pre-denial requests must not repopulate health or usage data. Include keyboard,
  focus, loading, empty, error, historical-version and permission states.

### 4. Rollout configuration

Add validated `CONNECTION_RUN_HEALTH_MODE=off|observe|enforce`, default `off`,
to applicable runtime/deployment configuration. Follow ADR059's production-mode
and consumption-mode rules; observe is not a backlog to replay on activation.
Record/apply evidence only in the appropriate mode and prove mode changes with
pending jobs. Local qualification may enable enforce in owned fixtures. No
production configuration or activation is authorized. Publish an operations
note covering backlog/poison-job diagnosis, safe mode disablement, manual
recovery, mixed-version deployment and rollback without schema history rewrites.

## Ownership and structure

Integrations error classification; database health transitions; worker
reporting from node attempts; contracts; web connections page.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).

## Frontend work

Health state and reason on the connections page and in workflow settings;
"used by" workflows; a reconnect or rotate action where needed.

## Backend work

Provider-specific classification of credential failures, bounded health
transitions from node attempts, a used-by projection, and a health-change
source for F27 notices.

## Delivery slices

1. Accepted ADR059 and manager plan (this checkpoint).
2. Durable dispatch/observation/delivery and safe manual recovery, with real
   database and worker tests; then authorized used-by and safe read contracts.
3. Existing-surface UI and real API/worker/browser acceptance, qualification,
   independent review, scoped PR and natural postmerge inspection.

Make coherent verified commits as each behavior becomes reviewable. Notices
remain deferred to F27; do not count them as implemented or block this slice on
them. Do not mark backend/frontend gates complete from stubs or mocked-only proof.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

A revoked credential marks the connection broken once, despite concurrent
failing runs; transient errors never do; a successful test restores it; used-by
lists exactly the dependent published workflows; no secret or provider text is
exposed.

Required qualification, in addition to the normal repository checks:

- Controlled PostgreSQL interleavings: concurrent rejection creates one
  transition; held old success after rejection cannot clear it; old rejection
  after a successful newly dispatched test cannot re-break it; rotation/revoke
  during provider dispatch/completion/application is respected; identical and
  mismatched duplicate completions and commands are distinguished. Exercise
  real production adapters/functions with runtime roles, not privileged seed
  shortcuts for the behavior under test.
- Real worker/outbox proof: provider result persists once, crash/restart before
  health application recovers, redelivery creates no duplicate transition and
  makes no additional provider call; health-application failure leaves the run's
  result/retry decision unchanged. Mode changes, purged evidence, migration
  upgrade and readiness/ACL drift are tested. Preserve existing unsafe-retry
  tests and all public outcome behavior.
- HTTP proof: authorized bounded usage pages include exactly the referenced
  retained versions without duplicates; drafts, other tenants, denied readers,
  revoked memberships and cursor swaps disclose nothing. Current/historical and
  archived labels are correct. Response/event/log fixtures contain no credential
  material or raw provider error text.
- Real browser against owned API, worker, PostgreSQL and Redis with only the
  external Slack transport controlled: execute a real published Slack workflow,
  deliver a definitive response, observe Needs reauthorization and correct
  used-by, test the same credential successfully and recover, then rotate and
  observe Unknown. Hold a stale run response across recovery/rotation and prove
  no regression. A permission-denied refresh cannot resurrect cached data.
- Give each integration/browser test exactly one enabled CI owner. Validate
  JSON gate reports with zero unexpected skipped/pending/todo tests; ordinary
  cohorts must exclude browser-owned fixtures. Record commands, source head,
  fixture/service ownership, teardown, test counts and evidence paths. Run the
  full applicable checks/coverage and inspect the rendered UI. No lowered gates,
  ignored tests, exclusion inflation or budget relaxation to obtain green.

## Non-goals

Automatic credential refresh beyond what each provider's auth already does,
provider status pages.

## Rollout and rollback

Off by default; observe durably classifies without changing health; enforce
applies eligible evidence. Disabling stops new automatic transitions but does
not erase an existing broken state. Test/Rotate remain the explicit recovery
path. A report-only phase records observations, not fictitious state transitions.

No production rollout, paid provisioning or real external calls are authorized
by this plan.

## Competitor context

Zapier marks expired app connections and offers a reconnect action that fixes
every Zap using them
([manage app connections](https://help.zapier.com/hc/en-us/articles/8496290788109-Manage-your-app-connections)).

Research checked 2026-09-29; product editions and availability can change.
This context informs the outcome, not Pertexo's implementation.

## Delivery tracker

- [x] Baseline reconciled against current code and accepted decisions.
- [x] Product choices resolved; ADR059 accepted for the narrow first slice.
- [ ] Contracts and security model reviewed.
- [ ] Backend behavior implemented and independently verified where needed.
- [ ] Frontend behavior implemented and independently verified where needed.
- [x] Real integrated acceptance evidence recorded.
- [x] Rollout/rollback and limitations documented.
- [ ] Scoped PR merged with required checks; natural postmerge result inspected.

Evidence log: 2026-10-01 manager baseline/ADR review on reviewed F29 head
`7561e82251762dd3b1e2f9f355f4a7376e331670`. The first slice is implemented in
`e5a44165` and integrated with qualified main by normal merge `f03191d3`.
Local qualification passes full repository checks, 795 real PostgreSQL cases,
86 non-artifact API service cases, the enabled controlled-Slack HTTP/browser
fixtures, and 24 source-bound coverage cohorts with zero unreviewed risk debt.
Owned fixture services/data were cleaned up; production remains off. Backend
and frontend implementation are locally verified, but their combined tracker
items above remain open until independent review. Contracts/security review,
scoped PR checks/merge and natural postmerge qualification remain open.
