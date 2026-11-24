# F64 — Community integrations

Delivered in [#877](https://github.com/vigani1/pertexo/pull/877),
[#878](https://github.com/vigani1/pertexo/pull/878),
[#879](https://github.com/vigani1/pertexo/pull/879) and
[#882](https://github.com/vigani1/pertexo/pull/882). Decision:
[ADR 099](../adr/099-community-integration-packages.md).

## Outcome

An external author can scaffold, test and publish a single-file integration
for a JSON HTTP API without a Pertexo PR. A self-host operator approves a
specific release and origin. Workspace users can find its actions, create and
test a connection, preview a step and publish a run using the same definitions.
Upgrades are explicit and an unavailable pin fails before any provider request.

## What other platforms show

- **n8n.** Self-host owners and admins install versioned `n8n-nodes-*` packages
  (including scoped names) through Settings. The verified program vets
  submissions against technical and UX requirements, including published
  provenance, and exposes approved nodes in the nodes panel. The `n8n-node`
  CLI scaffolds, builds and runs nodes locally and n8n publishes a starter.
  Its declarative style describes REST routing in JSON-shaped definitions
  without an `execute()` method, while programmatic nodes implement execution
  in code. Both ship in npm packages. n8n documents host and workflow-data
  access for unverified nodes and warns about breaking upgrades. Pertexo
  borrows the scaffold and local test loop and makes the installed file
  data-only. [Submission](https://docs.n8n.io/connect/create-nodes/deploy-your-node/submit-community-nodes),
  [install UI](https://docs.n8n.io/integrations/community-nodes/installation-and-management/gui-installation),
  [verified install](https://docs.n8n.io/integrations/community-nodes/installation-and-management/install-verified-community-nodes),
  [CLI](https://docs.n8n.io/connect/create-nodes/build-your-node/using-the-n8n-node-tool),
  [starter](https://github.com/n8n-io/n8n-nodes-starter),
  [node styles](https://docs.n8n.io/connect/create-nodes/plan-your-node/choose-a-node-building-style),
  [risks](https://docs.n8n.io/integrations/community-nodes/risks).
- **Activepieces.** Authors use the piece framework to build typed actions
  and triggers, distributed as versioned npm packages. The piece CLI builds
  a tarball and supports syncing custom pieces. The platform syncs compatible
  official packages from its cloud registry. Admins install custom/public npm
  pieces separately, or upload private archives. Published flow steps pin an
  exact piece version and upgrades go through the builder. Pertexo adopts
  explicit pins and keeps activation local to the operator.
  [Piece framework](https://www.activepieces.com/docs/build-pieces/building-pieces/overview),
  [build CLI](https://www.activepieces.com/docs/build-pieces/misc/build-piece),
  [custom sync](https://www.activepieces.com/docs/build-pieces/misc/pieces-ci-cd),
  [community publication](https://www.activepieces.com/docs/build-pieces/sharing-pieces/community),
  [loading and versioning](https://www.activepieces.com/docs/install/architecture/piece-syncing).
- **Make.** A custom app's JSON Base sets defaults for modules and RPCs,
  connections supply auth and verification, modules describe action
  communication, and RPCs fetch editor-time data such as dynamic choices.
  Host-owned communication makes destinations, credential placement and
  sanitization inspectable where the recipe is bounded. Make also offers IML
  and custom functions. Pertexo v1 keeps the mapping surface narrower and
  leaves editor-time network calls out.
  [Base](https://developers.make.com/custom-apps-documentation/app-components/base),
  [connections](https://developers.make.com/custom-apps-documentation/app-components/connections),
  [modules](https://developers.make.com/custom-apps-documentation/create-your-first-app/apps-environment/module),
  [RPCs](https://developers.make.com/custom-apps-documentation/app-components/rpcs),
  [custom functions in mappings](https://developers.make.com/custom-apps-documentation/best-practices/input-parameters/mappable-parameters).
- **Zapier.** Platform UI has a visual form mode for API calls and an optional
  Code mode. Platform CLI scaffolds local JavaScript projects and supports
  custom requests, middleware and other advanced behavior. Pertexo takes the
  form mode's constrained request shape and the CLI's local authoring loop
  without introducing two execution surfaces.
  [Platform UI vs Platform CLI](https://docs.zapier.com/integrations/quickstart/ui-vs-cli).
- **Incident.** Endor Labs reported npm packages impersonating n8n community
  integrations in January 2026, including a Google Ads lookalike designed to
  steal credentials. Publisher-looking branding and package discovery are
  weak signals of authority. Exact approval, host-owned auth and visible
  destinations address different parts of that risk.
  [Original investigation](https://www.endorlabs.com/learn/n8mare-on-auth-street-supply-chain-attack-targets-n8n-ecosystem).

## Implementation slices

### 1. Load one F57 registry per process

Put strict manifest decoding and compilation under
`packages/integrations/src/community/`. Produce normal `IntegrationModule`
values through the existing integrations server entry. Put filesystem loading,
approval matching and assembly in a community area of `node-catalog`, through
its existing server entry. Use a bounded reader for an explicitly listed
regular file under the operator's read-only package root. Reject path escapes,
symlinks, duplicate JSON keys, unknown keys, unsupported versions, and data
that exceeds host byte, depth, count or string limits. Parse from the bytes
whose checksum was verified. Keep plain text and built-in icons in the public
projection.

Move connection, slot and presentation indexing into the same registry
construction as operation registration. Supply that instance to catalog
routes, validation and portability, connection handling, execution and
preview. Use the existing node SDK catalog and registry checks for registrations
and ABI compatibility. Keep `INTEGRATION_MODULES` as the one built-in discovery
list and extend the dispatch check for the new composition seam. Core receives
typed descriptors and existing access ports from the application per ADR 091.
Integrations never import the catalog, core, database or secrets. No new package
entry points, roles or SQL tables.

**Prove it:** load a valid fixture through the production loader and edit one
byte without changing its approval. Startup refuses the modified file. Reject
invalid paths, unsupported ABI/format compatibility, collisions, broken
slot references and secret defaults before serving a catalog. With an empty
list, the official catalog and execution behave as before.

### 2. Run bounded recipes through HTTP Request

Support one request per action or manual credential test. Literal methods and
a fixed HTTPS origin are part of the registration. The host encodes typed input
scalars into path segments and query values and serializes mapped JSON bodies.
Output maps select bounded fields from the redacted JSON body or use the whole
bounded body. Use closed schema descriptors and typed references, without
scripts, general expressions, remote schema references, arbitrary headers,
files, pagination, protocol adapters or editor-time RPCs. Reject templates
that can change origin, traverse path segments or refer to a credential.
Use shared safe status/error codes and keep connection tests to GET/HEAD with
no user-entered test URL and no automatic invocation.

Support named API-key header, bearer and Basic recipes using the existing F57
tags. Use the host's header policy to reject reserved transport headers.
Resolve the pinned slot and exact workspace/provider/auth pair, then
inject auth at dispatch in trusted host code. No recipe or projection receives
secret material, auth headers, raw diagnostic bodies or callbacks. The host
applies its current response redaction and credential cleanup before mapping.
Preserve connection version checks and durable dispatch evidence. Built-in
HTTP Request must continue to accept only its existing slots and connection
types.

Extract the shared lifecycle inside HTTP Request where it currently binds to
`http` and `resolveHttpCredential`. The community registration supplies a
host-owned connection binding and bounded request material at that seam. Use
the same executor implementation for request preparation, dispatch,
cancellation, bounded response consumption and outcome classification.
Applications inject the secure client and credential runtime. A community
request and its credential test have zero redirects and use the secure
client's public-address policy with no private-network exemptions, even on
installations allowing them for built-ins. Check the approved origin before
opening credentials. The secure client still resolves and checks the address
used at connection time and enforces transport limits.

Require an explicit side-effect class. Support `safe` for GET/HEAD and
`unsafe` for writes, with operator review of read semantics. Reject inconsistent
class/method pairs and `idempotent_with_key` in v1. Do not accept a read that
mutates the upstream service. The runtime uses the registered class for
preview consent and the existing HTTP outcome policy and engine retry rules.
An ambiguous write yields an unknown outcome without automatic replay.
Provider classification, bounded Retry-After and transport retries are
host rules that packages cannot override.

**Prove it:** exercise the published-run and preview entry points plus the
normal credential test route against a fake API. Assert the intended request,
credential placement and output. Test that a wrong connection, a stale secret
version after rotation, an
unapproved target, a private address or a redirect cannot carry credentials
to a second recipient. Return an echoed key and verify redaction in output
and diagnostics. Show that a safe request can retry on a retryable outcome,
an unsafe preview requires consent, and an ambiguous write dispatches once
and ends unknown.

### 3. Deploy, retain and remove releases

Use a deployment config list, default empty, with the exact approvals from
the ADR. No directory scanning or install UI. Validate proposed changes in
the single-server storage `prepare.mjs` preflight using the production loader.
Stage a read-only generation from the approved files and feed both Compose
services its path and expected set digest. Derive the digest from a sorted
list of identities, versions, file digests, approved origins and the selected
current release per integration. Each API and worker verifies that generation
at startup. Roll a changed set as one deployment using the existing worker
drain procedure. Stop old admission and drain old workers before starting
the new generation. Leave the old deployment running if preflight fails.
Mount no package files in the web or Code runner.

At most one approved release per integration is current for new authoring.
Retained releases still supply descriptor and executor lookup by exact pin.
Show the selected current release in the picker and retain old presentation
for existing graphs. Keep a retired release approved until dependent
workflows and in-flight runs have migrated or finished. A retired release whose
operation contracts all reappear unchanged in the current release is no longer
needed by any pin. Removing an approval
withdraws all its pins, including for queued work. Surface the missing
package/version in editing and admission where available. Workers refuse
unresolved pins before credential access, including for queued or resumed
runs. Do not substitute a newer release, rewrite stored graphs or destroy
connection rows. Unsupported credentials remain listable and revocable.
Document backing up the approved release set alongside workflow data and
reinstalling exact bytes for rollback.

Record proposed approvals and removals in the operator's deployment
configuration history. Use the shared structured logger to emit a deployment
audit record before enabling the set, including timestamp, deployment
identity, package keys, versions, digests, origins, selection/retention and
result. Retain the preflight and activation records in operator deployment
logs across container replacement. Record rejected approvals with safe
reason codes. Use the host deployment principal as actor and keep
workspace audit on existing connection and workflow actions.

**Prove it:** run one isolated Compose deployment through install, upgrade
with retention, removal and restoration. Web shows the API's catalog.
A release that only rewords presentation keeps the published graph running
with no edit, and the editor shows the new wording.
Publishing after explicitly replacing a step uses the new release while
the previously published graph still runs against its original release.
After removal, the old pin cannot dispatch, including when a different file
claims the same version. A mismatched mount refuses readiness or job
consumption. The deployment logs identify the exact approved set and the
removal without including credential data.

### 4. Let authors publish without a Pertexo checkout

Give `apps/cli` an offline `pertexo integration init` and
`pertexo integration check` in the existing release image, with a writable
bind mount for the author folder. Scaffold that folder with the JSON release
file, a README and a fixture for an example read operation. The CLI check
calls the production loader and registry validator, reports field paths and
the artifact digest, and runs conformance examples using an isolated fake
HTTP provider and synthetic credentials. The conformance examples are data
that describe inputs, expected requests and fixture responses. The CLI owns
the test harness and author-facing commands. Existing
`/testing` exports are for repository tests and cannot serve as a production
CLI dependency. Use existing server entry points and avoid a second schema
or a published test-kit package.

Document testing a rendered form, credential and step in an isolated local
stack, following the [F57 proof](https://github.com/vigani1/pertexo/pull/835).
Only the test harness supplies a fake transport destination for a fixture's
approved origin. The production package format and deployment configuration
cannot enable this override. Document how to publish the artifact and
checksum as release assets, review endpoints and data usage, install,
retain old revisions and revoke approval.

**Prove it:** start from a scaffold in a clean author folder, check the
artifact, then approve that same artifact in the isolated stack. A workflow
author sees the tile and credential form, tests the connection and runs a
published step without changing Pertexo code. Invalid fixtures fail
conformance with actionable field errors.

## Deferred

Executable plugins, OAuth2 and query credentials for community packages,
triggers, pagination, private-network destinations, automated install and
updates, publisher signatures, hosted onboarding and a public index are out of
v1. One literal origin per package also leaves out APIs with per-account hosts
(a tenant subdomain such as `<account>.example.com`, or a self-hosted target).
The seam is an origin template whose only variable is one validated DNS label
from a connection field, under a registrable domain the operator approves. It
would extend the approved-origin check, not replace it. Pagination can later
reuse HTTP Request's existing pagination recipes through the same executor.
A future index supplies release metadata and the same downloadable bytes.
The reviewed local approval remains the install input. Giving third-party
code connectivity or host credentials requires a separate capability and
isolation design. The current Code runner has no provider network and does
not hold connection secrets.

Whether Pertexo later operates a public publisher namespace or verification
program, and who handles takedowns, is decided when a public index is planned.
Local publication and installation ship first and don't depend on it.
