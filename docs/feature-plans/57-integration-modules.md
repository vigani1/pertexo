# F57 — Integration modules

Status: accepted; slice 1 in progress. Decision: [ADR 095](../adr/095-integration-modules.md).
This is groundwork for community integrations. Installation is a later feature.

## Cost of adding a provider

The PostgreSQL addition in `a760caa91` (#810) changed 63 files in total.
Count paths in that commit, excluding the plan, tests and test support
(including the database fixture exports). The production and generated
footprint was 48 files in nine workspaces.

| Area | Files | Work |
| --- | ---: | --- |
| Integrations | 7 | Five files under `database/execute/`, two package entry files |
| Secrets | 4 | Three secure PostgreSQL client files and its server export |
| Web | 14 | Ten connection UI/model files, two catalog presentation files and two editor settings files |
| Contracts | 7 | Five schema/export files and two generated OpenAPI documents |
| Database | 6 | Table declaration, readiness check, SQL dump and migration SQL, snapshot and journal |
| Node catalog | 3 | Catalog, registry and portability slot map |
| Worker | 3 | Registry composition, connection resolution and failure presentation |
| API | 3 | Connection test dispatch, credential decoding and PostgreSQL test adapter |
| Workflow model | 1 | Connection vocabulary |

The audit's roughly 35-file estimate counts the main feature seams. The
commit count includes generated and incidental production changes. PostgreSQL
also needed a secure socket client. A typical new HTTP provider after F57
needs three production paths in two workspaces, as specified in slice 6. A
new login under a registered provider using an existing recipe changes one
`connections.definition.ts` file. The PostgreSQL and SMTP adapters remain
with secrets.

## Implementation slices

Each numbered slice is independently mergeable. Keep existing clients and
records working at every handoff. Commit file moves with only path and import
fixups first. Make behavior and registration changes separately.

### 1. Registry and presentation

Add `integrations/src/providers/integration-module.ts` for the module
interface, `integrations/src/modules.ts` for the discovery list, and
`node-catalog/src/integration-modules.ts` for registry assembly and validation.
The discovery list lives with its modules so the existing server entry can
expose it without re-exporting each module. Wrap the current definitions in modules pointing at their existing
files. In `catalog.ts`, derive `INTEGRATION_REGISTRATIONS`, manifests and
provider policies from the modules. Preserve the manifest identities,
versions and order. The F58 registration split moves executor assembly into
the modules. The remaining worker changes stay in slice 4.

Change `platformBrowserNodeDefinitionCatalog` in `browser-catalog.ts` to
project module presentation and expose it through
`createCatalogServices` in `apps/api/src/catalog/catalog.service.ts` and
`packages/contracts/src/schemas/catalog.ts`. Web catalog reads supply
versioned metadata to `describeStep` in
`apps/web/src/features/catalog/model/steps/presentation.ts`, including
outside the editor. Remove its browser import of the in-process platform
catalog. Use existing family fallbacks before catalog data arrives. Resolve
icons via a shared web icon vocabulary or fallback, and remove integration
entries from `steps/registry.ts`. Keep the core step grouping rules.

### 2. Connection definitions and form

Move one credential at a time, with create and rotation coverage for each.
Start with Slack and Resend, then HTTP Headers, PostgreSQL, SMTP, signing and
generic OAuth2. Put the schema, form metadata, auth/test recipes and safe
health keys in the owning connection definition file. Source the credential
envelope from `connection-credentials.ts`, `connection-fields.ts` and
`connections.ts` under `packages/contracts/src/schemas/connections/`.
Migrate consumers of the existing named schemas with each type. Rehome
shared bounds or protocol validation primitives below integrations if both
contracts and integrations use them. Keep the dependency graph acyclic.

Use the existing route declarations in `routes/connections/management.ts`
for the bounded envelopes. Select and parse the credential in API admission
before `connection-management.ts` enters a create or rotate flow. A rotate
request carries the auth key and expected secret version. Check them against
the workspace-scoped row at write time. Preserve custom test-URL and consent
shapes and existing error pointers. Switch
`apps/api/src/connections/testing/test-connection.ts` and
`decodeCredential` in `testing/credentials.ts` to registered test recipes and
existing secure adapter calls. Route dispatch lives in
`TestConnectionService.testProvider`. Keep generic OAuth2 authorization and renewal.

In the web app, project the connection definitions through the catalog and
use them in `CredentialFields`, `useCredentialForm`, `emptyCredentialDraft`
and `toConnectionCredential`. Extract the field rendering needed from the
editor's `SchemaField` in
`workflow-editor/components/inspector/fields/schema.tsx` for both callers.
Keep header-map editing and OAuth2 consent as shared controls. Replace the
PostgreSQL and SMTP field/draft modules as they migrate, and move OAuth2
preset facts from `model/oauth2-presets.ts`. Derive choices and health key
selection through `connection-providers.ts`, `provider-tile.tsx`,
`connection-health.ts` and the test panel. Preserve displayed labels,
defaults, editing semantics and secret-free read state.

Derive portable slot descriptors in `platformPortableDefinitionPolicy`
and resolve those same descriptors in editor selection and worker credential
access. Pass them into core authoring policy where needed. Preserve the
HTTP Headers/OAuth2 and Resend/SMTP compatibility rules now in
`connectionFitsSlot` in `workflow-model/src/authoring/connection-vocabulary.ts`.
Notification delivery retains its existing Email policy.

### 3. Open the auth key constraint

After registry admission covers create, rotate and credential use, replace
the fixed auth CHECK in `database/src/schema/connections.ts`, add one
forward migration, and update its snapshot, journal and `schema.sql`.
Check `database/src/platform/readiness.repository.ts` against the new
schema. Leave existing applied migrations alone. Exercise a populated
pre-migration database, including each auth type and OAuth2 grant state, then
verify the same IDs, rows, encrypted payloads and usable connections after
upgrade. Scope writes to registered providers and auth pairs before enabling
new keys. Reject a malformed key in SQL and a well-formed unregistered pair
at application admission.

### 4. Move executor composition into modules

Land HTTP Request, Slack, Email and Database as individually reviewable
changes. Their step folders already live under `integrations/src/http/`,
`slack/`, `email/` and `database/`. Keep files in place when they already
have the right owner. Use the existing executor factories such as
`createHttpRequestExecutorRegistration` and
`createDatabaseExecutorRegistration` through each module, with
`registerProviderExecutor` still applying telemetry. Fold integration
executors into `createPlatformNodeRegistry` in `node-catalog/src/server.ts`
by iterating the registry. Simplify the same-named worker factory in
`apps/worker/src/providers/node-registry.ts` to inject the secure HTTP
client, protocol adapters and telemetry. Preserve dispatch and cancellation
behavior and pinned ABI versions. Resolve failure declarations in
`apps/worker/src/attempts/delivery/executor-failure.ts` without a provider
allowlist. Remove redundant integration entry exports once their callers use
the registry.

### 5. Register polling and guard the seams

Attach `httpPollExecutor` and `fetchHttpPollItems` to the HTTP module.
Replace `createHttpPollFetcher` in `apps/worker/src/triggers/fetch-http-poll.ts`
and its use in `trigger.runtime.ts` with a registry resolver for the pinned
trigger definition. Thread the identity through the existing `FetchPoll`
seam if needed. Keep `processPollClaim` and `createScheduleTriggerScanner`
in core responsible for leases, budgets and committed position. Preserve
existing baseline, deduplication, credential health and auto-pause tests.

Extend the architecture checks with a checker and fixture test for the
former list owners named in the ADR. Check imports and literal keys at the
catalog, web, worker and schema dispatch points. The test inserts a provider
literal or a second registration into a consumer and expects rejection.
Allow module declarations, generic protocol tags and historical migrations.
Also check registry parity through its public interfaces so an omitted
projection or executor fails even when it uses computed keys.

### 6. Prove a provider fits

Open a standalone draft proof PR for a read-only JSONPlaceholder-style
`get-post` action with a named API-key header and declarative GET test. Inject
a local stand-in through the test environment's secure HTTP policy. Prove
the tile and form render, a connection can be created and tested, and a
published run sends the header and returns the JSON without exposing the
key. Exercise a rejected credential through the normal test route.

The expected diff has **four files**. Record the actual path count in that PR.

| Path | Change |
| --- | --- |
| `packages/integrations/src/example-posts/example-posts.module.ts` | Identity, read-only step schemas, executor and failure registration |
| `packages/integrations/src/example-posts/connections.definition.ts` | API-key schema, header application and test recipe |
| `packages/integrations/src/modules.ts` | One explicit registration |
| `apps/web/e2e-live/editor/product/example-posts.spec.ts` | One journey including the stand-in fixture |

If demonstrating the provider requires edits to a consumer, fix that seam in
the preceding slice before counting the proof. Keep the proof in draft while
it uses a stand-in. Shipping an example provider is a separate decision.

## Verification

- Run `pnpm check` and affected package tests per slice. Before the proof
  handoff run the full integration and editor suites using isolated stack
  names and ports.
- Exercise create, replace and test for all existing auth types. Compare
  rendered labels, required fields, defaults, masking and validation to
  today's forms. Check semantic schema failures at the API, including
  header normalization, OAuth2 preset and custom endpoints, SMTP sender
  fields and PostgreSQL TLS options. Saved credentials must stay masked.
- Verify the pre-migration fixture upgrades without row or payload changes
  and can still open and rotate credentials. Keep the secure HTTP and
  protocol transport suites green, including address policy and
  cross-workspace denial. Exercise existing workflow definitions and
  polling resumes against the newly assembled catalog.
