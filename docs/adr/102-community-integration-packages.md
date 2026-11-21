# ADR 102: Community integration packages and operator trust

- **Status:** proposed
- **Date:** 2026-11-21
- **Related:** [ADR 091](091-core-layer.md), [ADR 095](095-integration-modules.md)
- **Feature:** [F64](../feature-plans/64-community-integrations.md)

## Context

F57 proves that one module can supply a connection form, a credential test
and an action to the same registry. Its TypeScript modules run with the host's
privileges. Community authors need a way to publish independently of Pertexo
releases, and self-host operators need to control which material becomes part
of their deployment.

## Decision

### Package and identity

Ship one tier of community integrations in v1. A release is one bounded UTF-8
JSON file containing one integration module. Authors can publish the file as
a release asset alongside source, documentation and test fixtures. JSON gives
the operator one inspectable artifact and the host one parser. An archive
adds extraction and multiple files to validate. npm adds package-manager
semantics, dependencies and a code execution path we have no use for. YAML
would add a second input format. The host reads only explicitly listed files
and never fetches release assets.

The manifest contains a format version, publisher and integration slugs,
exact SemVer release, compatible host release range, presentation (plain
text names and descriptions and a built-in icon key), one literal HTTPS
origin, and actions. It may define one connection with bounded fields,
a host-supported auth recipe and a manual HTTP test recipe. Each action has
an operation slug, presentation, bounded input and output schema descriptors,
a literal method, path template, optional query and JSON body mappings,
an output projection and a side-effect class. Format v1 selects dispatch-aware
executor ABI 2 in the host. A package cannot choose an executor, ABI, policy
handler or import path.

Reserve `community.` for community provider, definition, executor and slot
keys and `community_` for community auth keys. Derive the provider key as
`community.<publisher>.<integration>` from validated lowercase alphanumeric
slugs. The installer approves the full identity, and the registry rejects
collisions with built-ins and across community registrations. Labels never
establish ownership. The catalog labels community entries as such and shows
the publisher and destination independently of the display name.

Published graphs already pin a definition key and integer version. Format v1
uses definition version 1 and a key formed from `community.` plus the unpadded
lowercase Base32 SHA-256 of the canonical validated operation contract, with
domain-separated, unambiguous encoding. The contract covers the provider key,
the exact origin, the operation slug, the method, path template, query and body
mappings, input and output schema descriptors, output projection, side-effect
class and the credential contract below. Presentation is excluded. A release
that only rewords names, descriptions or help keeps every pin. A release that
changes what an operation sends or returns produces a new key, which an old
graph pin cannot resolve to. The executor uses a separately domain-separated
key within the same size limit and the existing registration and ABI checks.
The registry merges identical operation contracts contributed by retained
releases into one registration that carries the current release's
presentation, and rejects conflicting ones. The loader rejects two different
digests for the same package and SemVer in one deployment. SemVer describes a
release to humans. The file digest is the operator's integrity check and the
contract key pins behaviour, the same split used for credentials below.

Stored credentials use the stable provider key and an auth key derived from
a domain-separated SHA-256 of the canonical validated credential contract,
including provider key, exact origin, credential schema, auth application
and credential test recipe. Encode it as `community_` plus unpadded lowercase Base32. Derive the
slot from the same contract. This fits existing key checks and widths. Changing
a recipe's target or credential placement requires an explicitly created
replacement connection. Operation and presentation changes can reuse a
connection when that credential contract is identical. The registry merges
identical connection contracts contributed by retained releases into one
entry per provider and auth key. It rejects conflicting definitions.

### Approval and execution

A self-host operator approves each release by adding the relative file,
publisher/integration key, exact version, SHA-256 of the exact bytes, and
exact HTTPS origin to deployment configuration. Approval covers all
operations and their disclosed effects. A checksum checks integrity against
the operator's reviewed copy. Publisher signatures and public identity
verification are deferred. An approval is local to the deployment.

Both API and worker validate the same immutable release set at startup,
before readiness or job consumption. The catalog assembles those modules
with the built-ins through the F57 registry. The web reads its existing
public projection from the API. The deployment records approval and
activation with the operator's configuration history and structured
deployment logs, scoped to the installation. Workspace audit remains
responsible for connection and workflow actions.

The host constructs requests from bounded, typed mappings and injects
credentials only through the connection runtime, at the approved origin.
Reuse the HTTP Request executor's request lifecycle, secure transport,
dispatch evidence and outcome policy. Community recipes expose no code,
secret values, arbitrary request destinations or ambient capabilities.
Ordinary workspace access checks still apply. Package approval entails
trust in the chosen provider and endpoint semantics. That provider receives
the credential for authentication and whatever workflow data the operation
explicitly maps into the request.

### Consequences

Release files and approvals are part of deployment backups. Keep an older
approved release installed while workflows or runs still need its pins.
A removed release leaves those pins unresolved and Pertexo fails closed.
Reinstalling the exact approved bytes restores resolution for future attempts
under normal run rules. A replacement release requires an explicit graph
edit and publish.

A public index can later advertise downloadable releases and their digests.
It would produce the same operator-reviewed install input. Executable
extensions require a separate decision about isolation, upgrades and
credential authority. The networkless Code runner executes user tasks with
a different contract. Adding plugins would require a broker for per-operation
provider capabilities and a separate lifecycle. The declarative seam can
accept another host-owned definition source later, and no first-year
requirement currently warrants building or granting process trust to that
tier.
