# ADR 095: Register each integration as one module

- **Status:** accepted
- **Date:** 2026-11-21
- **Related:** [ADR 091](091-core-layer.md), [ADR 092](092-route-declarations.md),
  [ADR 093](093-polling-triggers.md)
- **Feature:** [F57](../feature-plans/57-integration-modules.md)

## Context

Adding the PostgreSQL Database step required edits to the integration, catalog,
worker, API, editor, credential contracts and database. The catalog knows which
steps exist, yet separate lists tell the worker how to run them, the editor how to
present them and the API which credentials it can admit. Adding another HTTP
provider should take one folder and one catalog entry. Adding a login to an
existing provider using a supported authentication method should take one
definition-file edit.

## Decision

**One folder and one explicit registration.** Each integration under
`packages/integrations/src/<integration>/` exports one module from
`<integration>.module.ts`. It declares its key, name, icon and group,
connection definitions, and versioned step and trigger registrations with their
schemas, executor factories, policies, safe failure codes and any polling fetch
adapters. A registration carries the existing node-sdk definition and executor
identities. A step can inherit its module's presentation metadata or override it
in its definition. Existing provider, operation, step, slot and executor keys
keep their meanings, including where they differ today, such as the Database
step and the PostgreSQL connection. Core signing advertises its existing
credential from its owning module.

The only discovery list lives in `packages/node-catalog/src/integration-modules.ts`
under the existing Node-only entry. Each line is an explicit module reference
using a literal import path. Resolve these imports when composing the server
catalog and validate uniqueness and references before serving requests or starting
worker jobs. Explicit imports let TypeScript check the targets and allow bundlers
to discard unused exports. The browser never loads the executable registry.
Keep the browser projection in the existing catalog routes as data and construct
it once at API startup. Each module's registration contributes to
`createNodeCatalog` and `createNodeRegistry`, which still check the pinned
definition and executor pair. Executor compatibility stays in node-sdk's
existing ABI versions, including dispatch-aware ABI 2. There is no separate
module version to synchronize with the executor ABI.

**Declare how a connection is entered, applied and tested.** The module's
`connections.definition.ts` owns each login's auth key, Zod credential schema,
slot compatibility and test recipe. Field metadata uses the same `title`,
`description` and `default` conventions as step settings and
`labelledChoice` for labelled choices. Mark secret fields in that metadata,
including map values such as HTTP headers. Use the markers for input masking
and runtime redaction, with whole-credential protection for fields the runtime
cannot classify. Use `generateSchemaDocument` for the public form projection
and the Zod schema for authoritative validation, including refinements the
projection cannot represent. Project field shape, hints and safe defaults.
Secret defaults are invalid.

Define authentication as a tagged recipe for header map, named header, query
parameter, Basic, bearer or OAuth2. The connection runtime applies it to an
approved request. A test recipe declares the method, target, safe outcome
mapping and any required user input or consent. The runtime enforces target
policy, request bounds and the existing side-effect disclosure. HTTP Headers
can still accept a test URL from the user. OAuth2 presets declare authorize and
token URLs and scopes and continue to store and renew a generic `oauth2`
connection. PostgreSQL and SMTP select a built-in protocol adapter implemented
in `@pertexo/secrets/server`. That package owns the sockets and their address,
TLS and timeout policy. The module supplies typed operations and consumes the
injected adapter.

**Store keys and enforce membership in TypeScript.** Keep the existing
`connections.auth_type` width and replace
`connections_auth_type_valid` with a format check accepting
`^[a-z][a-z0-9_]*$`. Keep the existing provider-key format check. The
registry admits the provider and auth pair at create, checks the current row's
pair at rotation and resolves the same definition when opening a credential.
Validate the credential once at each input boundary that opens or accepts it.
Core retains workspace authority, rotation checks and locking inside its
transaction. Core and workflow-model can consume typed slot descriptors
supplied by the application without importing the registry.

Contracts own the bounded wire envelope and the route declaration. API
admission selects the registered Zod schema after reading the discriminant,
before the command runs. Keep ADR 092's JSON Pointer field errors and route
guards. Document the stable envelope in OpenAPI and serve the provider-specific
form schemas through catalog discovery. This keeps contracts below integrations
in the dependency graph and permits adding a login without editing a contract
or regenerating an OpenAPI enum. Existing request fields, response values,
stored auth keys and encrypted payloads keep their formats. OAuth2 keeps its
existing response branch, references and lifecycle.

Use a forward-only migration that changes only the check constraint. Existing
rows satisfy the new constraint and need no rewrite or re-encryption. Migrate
before admitting any new auth key and upgrade readers and workers before
exposing a new module in a rolling deployment. Retain a reader for every
persisted credential type shipped with Pertexo. An unrecognized stored key can
be listed and revoked through the generic envelope and is refused for credential
use with a safe error.

**Derive the places that consume the module.** The registry replaces
`INTEGRATION_REGISTRATIONS` and the separate integration policy entries in
`node-catalog/src/catalog.ts`, the integration executor array in
`node-catalog/src/server.ts`, and `CONNECTION_SLOT_POLICIES` in
`portable-definition-policy.ts`. It replaces the provider/auth enums and
credential/test variants in the contracts connection schemas, the membership
list in the worker's `providers/connections.ts`, and the HTTP provider
factories in `providers/node-registry.ts`. The current worker polling factory
becomes a catalog lookup by pinned trigger identity. The module fetches and
validates items within the supplied budgets. Core retains claiming, baseline,
deduplication, admission and durable position under ADR 093.

The web derives provider tiles and credential labels from the public catalog,
replacing the provider and choice tables in `connection-providers.ts`,
provider-specific entries in `provider-tile.tsx`, and integration entries in
`stepIcons` and `connectionWords`. Reuse shared schema field rendering and keep
generic controls for header rows, secrets and OAuth2 consent. Registry failure
declarations map provider codes to shared web health copy keys. Generic web
copy and rendering stay in the web app. Replace provider-specific mappings in
`connection-health.ts` and the connection-test panel with that projection.
Shared UI controls, core step presentation and protocol-wide behavior retain
their own owners.

**Supply capabilities through the host.** An integration can transform and
validate values, register operations and ask the runtime to authenticate, send
a bounded request or run an allowed protocol operation. HTTP goes through
`ProviderHttpClient` backed by the secrets secure client. Credentials go
through the connection runtime and `withProviderCredential` or its existing
OAuth2 lifecycle. Preserve workspace access, target checks, dispatch fences,
retry classification and secret zeroing. The integration package has no access
to direct network or database clients, the filesystem, environment, secret
storage or unredacted diagnostics. The public projection excludes executors,
auth application recipes, secret values and transport policy. These are rules
for reviewing trusted in-tree code. Loading arbitrary JavaScript would require a
separate trust and isolation decision.

## Consequences

- A typical HTTP addition contributes one module folder and one explicit
  catalog entry. A new login using a supported recipe extends the owning
  connection definition file. New socket protocols require a reviewed secrets
  adapter and host wiring.
- A deployment serves the same definitions to validation, presentation and
  execution. Compatibility checks cover existing published node versions and
  connection records alongside new registrations.
- A later community installer could supply additional reviewed modules at the
  same catalog seam. Package installation, signing, trust, admin opt-in and
  third-party code isolation are outside F57.
