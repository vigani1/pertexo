# Self-managed encryption keys

Status: implementation complete and locally verified, 2026-10-13. Existing CI
gates each slice before merge; actual production rollout is not claimed. ADR
071 permits private self-managed keys with the complete deployment gate.

## Outcome and scope

An installation chooses AWS KMS or a self-managed master key through server
configuration. Both protect the data keys for connection credentials and
webhook secrets. Encrypted credentials remain in PostgreSQL. The editor,
workflow engine, credential permissions and provider executors keep their
existing interfaces.

The self-managed option works in development, staging and production. Production
requires private, randomly generated keys; it refuses the public development
key. KMS remains the recommended option for Pertexo's hosted deployment.

Use the existing envelope cipher and versioned application-secret helper. Add
no service, dependency, database role, migration, stored envelope format,
package entry point or CI job. Existing maintenance authority performs the
installation-wide verification; the API keeps its app-role credentials.

This is credential encryption portability, not a claim that all independent
self-hosting work is complete. Mail-provider portability, multi-architecture
image publishing and the owner-assisted beta launch are separate work.

## Findings from the current code

| Location | Current behavior and consequence |
| --- | --- |
| `packages/integrations/src/crypto/envelope-cipher.ts` | One AES-256-GCM credential cipher with a key-provider interface. Keep it. |
| `packages/integrations/src/security/application-secret-envelope.ts` | Wraps with a current key and opens with current or previous keys. It already stores `keyVersion`; duplicate versions currently overwrite in a `Map` and must be rejected. |
| `packages/integrations/src/credentials/local-key-provider.ts` | Uses the shared helper, but passes one key and the fixed reference/version `local:development`. Versioned configuration belongs here, not in each consumer. |
| `packages/integrations/src/credentials/runtime.ts` | Shared API/worker parser rejects local mode when deployed and rejects mixed settings. Keep the single parser and fail-closed behavior. |
| `packages/integrations/src/webhooks/crypto.ts` | Already uses the same local provider and connection encryption configuration. Webhooks must receive the same improvement. |
| API identity config and worker `config/application-key-ring.ts` | Both parse previous-key JSON independently. Consolidate the relevant key-ring rules in integrations; preserve mail and invitation variable names and behavior. |
| `packages/database/migrations/0000_baseline.sql` | Both secret tables grant existing maintenance-role SELECT and cross-workspace policies. The API cannot directly SELECT webhook secrets; broad API verification would require authority it does not have. |
| `apps/worker/src/worker.module.ts` | Some polling runtimes start while Nest constructs the context. Checking keys only after `createApplicationContext` is too late. |
| `infrastructure/single-server/compose.yaml` | Requires KMS reference, region and AWS access keys unconditionally. Changing the TypeScript parser alone cannot enable self-managed deployment. |
| `infrastructure/single-server/storage/prepare.mjs` | Uses compiled application parsers and produces private API/worker env files. Reuse it to pass identical encryption settings. |
| `infrastructure/single-server/generate-secrets.mjs` | Generates deployment secrets on stdout; the example/runbook warn against rerunning over installed keys. Extend this script and send warnings to stderr. |
| `infrastructure/single-server/restore.sh` | Clears its restore fence after restoring data and objects. Key verification must succeed before the fence is cleared. |

## Configuration contract

The canonical modes are `kms` and `self-managed`. Keep the existing implicit
KMS selection when KMS settings are supplied, so current hosted deployments do
not require a configuration change. An explicit mode is recommended in examples.
No production fallback or automatic provider selection based on stored data.

Self-managed configuration:

```dotenv
CONNECTION_ENCRYPTION_MODE=self-managed
CONNECTION_SELF_MANAGED_KEY=<base64-encoded random 32-byte key>
CONNECTION_SELF_MANAGED_KEY_VERSION=1
# Optional JSON, with the same shape as existing application key rings:
# CONNECTION_SELF_MANAGED_PREVIOUS_KEYS=[{"version":"0","key":"<previous key>"}]
```

KMS configuration remains:

```dotenv
CONNECTION_ENCRYPTION_MODE=kms
CONNECTION_KMS_KEY_REFERENCE=alias/pertexo-connections
CONNECTION_KMS_REGION=eu-central-1
```

KMS uses the existing SDK credential chain: an IAM role when available, otherwise
privately supplied AWS credentials. It does not need self-managed key settings.
Self-managed mode does not require KMS configuration or AWS credentials for
encryption; artifact and backup credentials remain independent settings.

Validation at the configuration boundary must:

- require a complete current key/version pair in self-managed mode;
- use the existing 32-byte base64/base64url acceptance and key-version grammar;
- accept at most eight previous keys, matching the existing key-ring limit;
- reject duplicate versions, including a previous version matching the current
  version, before constructing the envelope helper;
- reject one decoded key value assigned multiple versions in the self-managed
  ring: renaming the same key is not rotation;
- reject malformed or unknown mode values and conflicting provider settings;
- refuse the decoded public `.env.example` key in **any** ring position when
  staging or production is selected, including alternate base64 encodings;
- preserve the deployed KMS completeness and HTTPS endpoint requirements;
- report variable names and safe error codes without printing supplied values,
  previous-key JSON, ciphertext or raw schema-error causes.

Do not pretend to measure randomness from a supplied key. Correct byte length
and refusal of known public fixtures are checks; secure generation and custody
remain part of the installation procedure.

Keep legacy `CONNECTION_ENCRYPTION_MODE=local` plus `CONNECTION_LOCAL_KEY` as a
development/test-only compatibility input, normalized by the same parser into
the self-managed provider. Reject it when deployed and reject mixing legacy and
canonical variables. New examples use the canonical names. This is one provider
with a bounded input compatibility rule, not a second encryption implementation.

No auto-generated master key at API/worker startup: separate processes could
generate different keys, and the runtime containers are read-only.

## Stored compatibility and rotation

Keep existing database columns and envelope fields, including the historical
name `kmsKeyReference`. Renaming that persisted field is outside this feature.

For new self-managed wraps, use the opaque provider reference `self-managed`.
The existing inner application envelope records the configured `keyVersion`;
that version selects the current or previous master key. Do not add a second
version field or another serialized wrapper. Bind wrapping to the existing
connection/webhook associated data and reject an unexpected provider reference.

Read legacy `local:development` wraps through the same implementation when the
configured ring contains their actual inner version `local:development`. Do not
try each key until one succeeds or guess a version. A private legacy key can be
supplied explicitly for compatibility; the public development key remains
forbidden when deployed. Test old stored bytes, not just newly generated data.

Routine rotation is a coordinated restart:

1. Back up the new key/version and all still-needed previous keys separately.
2. Stop serving writers using the existing deployment operation lock.
3. Configure a new random current key with a new version; move the old current
   pair into previous keys. Do not change an existing version's key value.
4. Verify the retained wrapped data keys, then restart API and worker with the
   same ring. New secret versions use the new current key; old ones remain
   readable under previous keys.

This rotation does not rewrite stored data keys or make the old master key safe
to discard. Keep keys required by retained database rows **and by every recovery
point the owner still intends to restore**, even if live rows have been purged.
Do not silently drop a ninth previous key; stop and explain the ring limit.

Rewrapping and cross-provider migration are deferred. Neither direction of
switching between KMS and self-managed encryption is supported on an installation
with retained secrets from the other provider. Verification refuses the mismatch
before new writes. Changing a KMS alias/reference remains governed by the existing
KMS behavior; this plan does not add KMS key migration or retirement.

Previous-key rotation is not recovery from compromise. Retiring a compromised
master key requires separate migration work and may require replacing exposed
integration credentials. The first release must not advertise that capability.

## Responsibilities and layout

Paths below are intended implementation locations, not permission to create
unused abstractions. Keep each module small enough for its responsibility and
introduce exports only with real callers in the same PR.

| Location | Responsibility |
| --- | --- |
| integrations `security/key-ring.ts` (new) | Shared current/previous key configuration validation and types. Reuse it in the envelope helper and API/worker identity parsers; keep each environment-variable prefix in its owning configuration parser. |
| integrations `security/application-secret-envelope.ts` | Existing authenticated application-secret encryption; accept the validated ring without duplicating crypto. Retain validation for direct public callers. |
| integrations `credentials/self-managed-key-provider.ts` (rename) | Current-key wrapping, exact-version unwrapping and legacy stored-reference support. Implements the existing `EnvelopeKeyProviderCore`; no database imports. |
| integrations `credentials/runtime.ts` | One environment parser and factory for both providers, with legacy-input normalization and deployed policy. |
| integrations `credentials/verify-stored-keys.ts` (new) | Checks an async stream of typed wrapped-key records against the selected provider. Owns provider compatibility, authenticated self-managed unwrap and safe failures. No SQL, Nest or process environment reads. |
| integrations `webhooks/crypto.ts`, `server.ts` | Share the provider for webhook secrets; expose only the server interfaces the callers actually need. |
| database `platform/encryption/keys.repository.ts` (new), `platform/index.ts` | Read-only, bounded stream of retained wrapped-key records using the existing maintenance role and pool runtime. No encryption, JSON-envelope decoding or provider-selection rules in SQL. |
| worker `runtime/startup/verify-encryption.ts` (new), `app.ts` | Compose repository and verifier before Nest context creation; close startup resources on success/failure. Use `config.retention.maintenanceDatabase`; never start a polling loop or dispatcher before verification. |
| API `platform/config/api.ts` and runtime factories | Pass the shared typed configuration to connection/webhook runtimes. Do not add maintenance credentials to the API. |
| infrastructure `single-server/encryption/verify.mjs` (new) | Thin release-image wrapper around compiled database/integrations interfaces. Read-only preflight, safe output, timeout and cleanup. Run in the existing on-demand ops container; no new service or general-purpose ops command. |
| infrastructure Compose, `storage/prepare.mjs`, generator and examples | Supply identical canonical settings to API/worker, conditionally require provider settings through the real parsers, and keep private file permissions. |
| infrastructure deploy/restore/qualification and operations docs | Gate serving/recovery, exercise the public setup path and explain key custody. Keep encryption policy out of shell scripts. |

The runtime image currently copies compiled apps/packages, not infrastructure
scripts. Bind-mount the selected release's verification wrapper read-only for
the one-shot invocation, following the existing prepare/backup scripts. Supply
its private env file only to that invocation; ordinary ops commands do not need
master keys. Do not introduce a new image target or copy arbitrary source into
the runtime image. The packaged-runtime qualification must exercise this mount
and the compiled exports it uses.

Rename the provider and its type from `Local…` to `SelfManaged…` in a dedicated
buildable move/rename commit. Import updates required by the rename belong in
that commit; behavioral changes follow separately. Add no root-level `crypto`
package, generic secrets registry, provider plugin system or consumer-named
database entry point.

## Verification before serving

### What the database reader returns

Read `app.connection_secret_versions` and
`app.webhook_trigger_secret_versions`, including historical, revoked and archived
rows until normal lifecycle retention deletes them. Return only the secret kind,
workspace ID, connection/trigger ID, secret-version ID, opaque key reference and
wrapped data key. Credential ciphertext is not needed for this check.

Use existing maintenance-role SELECT grants and policies. Do not grant the API
cross-workspace reads, use a superuser, disable forced RLS or add a security
definer function. Verify this against real app and maintenance logins.

Use a read-only repeatable-read transaction and keyset pages of at most 250 rows
per table, ordered by the existing primary-key identity. Keep one coherent
snapshot, bounded memory, cancellation and existing pool deadlines. Verification
has a 120-second total deadline and fails closed if it cannot finish. This leaves
startup time within the current 180-second deployment wait; qualification must
also check the worker health-check budget. Release
the transaction/client/pool on failure, cancellation and early iterator exit.
Measure with several pages in tests; do not preload all rows into an array.

This is an intentional installation-wide maintenance operation. It preserves
the API's workspace isolation; it does not claim the maintenance role is itself
limited to one workspace.

### What the crypto verifier proves

In self-managed mode, authenticate and unwrap **every retained data-key wrap**
with its recorded version and original associated data, then promptly clear the
returned plaintext data-key buffer. This catches missing versions, wrong values
under a correct version name, corruption and context mismatches without opening
the integration credential itself. It also detects a retained KMS wrap before
any writes occur. There is no persistent verifier record or secret fingerprint.

In KMS mode, refuse known self-managed/legacy local references, but preserve the
existing KMS encryption/decryption path. Do not introduce a KMS call for every
historical secret on startup, or claim that the metadata check proves KMS
permissions, key availability or decryptability. Existing KMS tests and owner
provider smoke checks still establish those separately.

With no retained secrets, verification can validate configuration and provider
construction only. It cannot tell whether an otherwise valid random key is the
owner's intended key. Report zero checked records; never create a stored probe
or silently generate a replacement master key.

Failures identify a safe category such as missing key version, unavailable key
material, malformed wrap or incompatible provider. Wrong bytes and corrupted
authenticated data may be indistinguishable; report that accurately. Log no
raw records, keys, ciphertext or unsanitized nested crypto/parser exceptions.

### Where the gate runs

1. **Deploy:** after migrations succeed and while API, worker and public ingress
   are stopped, run the selected release's verifier in the existing ops
   container. A KMS rollback to a pre-verifier target uses the currently installed
   compatible verifier/image, keeping retained-key checks in place. Only then
   start serving and record a healthy release. Use the
   same prepared encryption configuration as API and worker. Preserve current
   migration-fence and rollback rules. A key verification failure keeps serving
   stopped for an operator configuration fix; do not resume an old image with
   changed keys or remove a migration fence to bypass it.
2. **Worker startup/restart:** verify before constructing the Nest context,
   because its factories already start background work. Use a short-lived
   startup repository and close it before ordinary runtimes start. Run this
   once per startup, not on each readiness poll.
3. **Compose boot ordering — deferred by the owner:** API and worker retain
   independent startup, with their existing migration/data-service dependencies.
   Do not add an API dependency on worker health. Deployment preflight and the
   worker startup check provide the selected guarantees; additional ordering can
   be added later if an observed failure justifies it.
4. **Restore:** verify the restored database with separately supplied key
   material before clearing the existing restore fence. On failure retain the
   fence and restored data for diagnosis. Recovery still requires a fresh stack
   as defined by the existing procedure; do not add an in-place restore mode.

The installation-wide guarantee applies to deployment and restoration; the
worker also verifies before starting its own work on every startup/restart.
The API performs configuration checks but cannot verify every workspace's key
values with its app role, and does not wait for worker verification or health
when it starts independently. A plain Compose boot is not an installation-wide
key-value check. Document these limits without broadening API database authority
or adding a global health fence.

Keep the deployment-generated configuration identical and immutable for a
running release. Configuration changes and restored data use the coordinated
stop/preflight/start or guarded restore sequence; operators launching processes
outside that sequence must run the read-only preflight first with the same
configuration. ECS remains KMS-only in this feature; an independent self-managed
ECS rollout needs its own deployment gate before it is advertised as supported.

Self-managed configuration requires a release that implements this plan's gate.
An older KMS-only image cannot become a rollback target just because the database
schema is unchanged. Do not attempt that rollback with self-managed settings,
and do not regenerate keys to make an old image start. Test a rejected older
release and retained serving-stop behavior; document fix-forward for this
configuration transition. The trusted installed deploy control script must
refuse a selected release without the verifier when self-managed is selected,
before restarting anything. Automatic rollback also validates the target image
with its own compiled API/worker parsers through the existing preparation
script. An interim image may contain a verifier while still refusing production
self-managed mode, so file presence alone is insufficient. Keep the existing KMS rollback behavior for releases
which never selected self-managed encryption.

## Generation and deployment configuration

Extend `generate-secrets.mjs` with an explicit encryption selection argument.
Its no-argument behavior remains KMS-compatible for current callers. Selecting
self-managed emits mode, a random 32-byte base64 master key and version `1`;
selecting KMS emits no self-managed key. Preserve all other generated secrets.
Warnings and password-manager guidance go to stderr; stdout remains valid dotenv
data and never contains guidance text. Run only on a trusted owner machine or
with the existing runtime image. Do not execute it during deployment or restore.

Remove unconditional KMS requirements from Compose. The compiled configuration
parsers decide which provider fields are required. `storage/prepare.mjs` writes
only the selected encryption settings, including previous keys, to both private
API/worker env files and the private verification env file. Omit unused fields
instead of passing empty strings; Compose treats an empty value as configured
unless the application explicitly says otherwise. Ensure explicit `environment`
entries cannot override the prepared provider settings.

The verifier's env file also contains the existing maintenance connection URL.
Do not send it to the API. Extend existing private-file generation rather than
adding a persisted verification result or marker. Keep directories mode 700,
files mode 600, no shell sourcing, no secret-bearing command-line arguments and
no keys in web build variables, Docker layers or committed example values.
The supported initial delivery uses the private server env file; mounted-secret
file configuration is deferred rather than inventing `_FILE` settings now.

## Backup and recovery contract

Backups contain the encrypted credentials and wrapped data keys, not the master
keys or production env file. Keep key material in separately protected owner
custody. The server necessarily has a runtime copy; separate backup custody
means a leaked database recovery point does not include its decryption keys.

Before first deployment or rotation, save current and previous key/version pairs
and the selected provider in the owner's password manager. Preserve the existing
mail/invitation keys independently. For KMS recovery, preserve access to the
original KMS keys; copying AWS access credentials alone is insufficient.

Extend the existing real backup qualification to insert connection and webhook
secrets under two private self-managed master-key versions. Restore the normal
matched database/object recovery point into a fresh stack, supply those keys
separately, pass preflight, and open the restored secrets through existing crypto
interfaces. Independently restore with a missing previous key and with wrong
bytes under the right version name: both must fail clearly and leave serving
blocked. Include a webhook-only database so connection sampling cannot hide a
webhook key problem. Do not put fixture keys into the recovery prefix.

Qualification must also show that backup uploads contain only the existing
fixed recovery files and object tree, with no generated/private env files or
master keys. Keep recovery-point format, object metadata and adapter unchanged.
Actual owner launch and remote restore evidence remain beta slice 6.

## Delivery sequence

One PR per implementation slice, in order; each stays buildable. The owner approved this plan with Compose boot ordering deferred.
The ADR amendment lands with the complete deployment gate.

- [x] 1. Shared key-ring rules and provider naming. Consolidate current/previous
  key validation, reject duplicates, rename the provider separately, add
  versioned wrapping and legacy-byte tests, update API/worker consumers. Keep
  the deployed self-managed gate closed until the full serving gate exists.
- [x] 2. Read-only stored-key verification. Add the maintenance repository,
  crypto verifier, worker check before context creation and release preflight
  wrapper. Cover all retained rows, cancellation, cleanup, safe errors and real
  RLS authority. Consume each new export in this PR; keep production policy
  closed. Update existing dependency-entry checks for the new script if needed.
- [x] 3. Enable the complete deployment path. Add generator selection,
  canonical examples, provider-specific prepared env files, deploy/restore
  preflight while preserving independent API/worker startup; then permit
  canonical self-managed mode
  when deployed. Refuse known public keys and incomplete/conflicting settings.
  Amend ADR 071 in place with a dated decision and link this plan; update the
  beta plan's KMS-only claims and owner prerequisites without marking slice 6
  done. Publish configure/rotate/recovery instructions in the existing runbook.
- [x] 4. Recovery qualification and final documentation. Extend the real matched
  backup/restore drill and packaged-runtime check for both configurations;
  finish examples and operational failure instructions. Preserve KMS regression
  coverage and record evidence and remaining owner-only checks honestly.

Every commit passes lint, TypeScript and relevant behavior tests. Each PR reports
Moved/Removed and added/removed lines; rename commits stay separate from logic.
Do not amend, locally rebase, force-push or skip hooks. Push/merge requires owner
authorization for this feature; merge by rebase only after existing CI is green.

## Verification matrix

| Behavior | Required evidence |
| --- | --- |
| New wraps use current version; previous versions still open | Connection and webhook crypto tests, distinct random master keys, restart with the parsed ring. |
| Legacy bytes remain readable | Fixed old envelope representation and legacy mode/config normalization; no fallback-key trial. |
| Configuration failures | Missing pair, wrong length, invalid JSON/version, more than eight previous keys, duplicate version/key, mixed modes and decoded public fixture in every ring position. |
| Shared helper consumers | Existing invitation and authentication-mail tests pass after parser consolidation; their variables and stored envelopes remain compatible. |
| Wrong key with correct version | Authenticate existing wrapped data keys and fail before polling, queue consumption, readiness or serving. |
| Coverage | Multiple workspaces, several pages, connection-only and webhook-only rows, old/revoked versions, missing historical key, empty database and corrupted later-page wrap. |
| Database authority and lifetime | Real app login cannot gain global reads; maintenance can read both tables; snapshot, timeout, abort and iterator cancellation release resources. |
| Provider mismatch | KMS rows block self-managed startup; self-managed/legacy rows block KMS startup; no row mutation or new secrets written. |
| Deployment | KMS defaults still parse; self-managed needs no AWS encryption settings; both runtime env files match; unused fields omitted; verification precedes all serving starts and preserves migration uncertainty. |
| Lifecycle | Worker verifier runs before Nest factories; no worker background task on failure; API startup does not depend on worker health and receives no maintenance URL. |
| Restore | Correct separately supplied ring works; wrong/missing key preserves restore fence; secret bytes usable after real database/object restoration. |
| Custody and leakage | Generator stdout parses as dotenv; warnings only stderr; keys absent from backup payload, logs, web environment and image layers. |
| KMS regressions | Existing SDK call arguments, associated context, timeouts, credential resolution and encryption tests remain unchanged; metadata scan is not presented as an AWS permission test. |

Use the existing commands and CI jobs:

```sh
pnpm format:check
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm dependencies:check
pnpm architecture:check
pnpm database:schema:check
pnpm contracts:check
node --test infrastructure/single-server/test/*.test.mjs
pnpm test:integration
pnpm test:e2e
```

For service integration, use the flags and owned-fixture manifest from the
existing CI workflow. Keep database and service groups on separate disposable
Compose projects: service tests deliberately restart PostgreSQL and Redis.
Local integration checks used a 30-second test-runner timeout for the large
fixtures, without changing application timeouts or behavior assertions.

Run the existing storage/recovery qualification and packaged-runtime checks for
slices 3–4 with the existing pinned images. Request owner permission before a
missing Docker image download. Do not call real AWS, send mail, deploy to the
owner's server or perform beta slice 6 as part of local verification.

## Design review and deferred work

The checked design has one crypto implementation, one key-ring shape and one
provider parser. Database code only reads metadata; integrations owns the key
rules; worker/deployment owns ordering and cleanup. Every introduced module has
a concrete caller. These responsibility checks were verified during implementation.

The main trade-off is complete self-managed verification at boot: work grows
with retained wrapped-key rows and can hold a read snapshot for up to two
minutes. This is acceptable for the single-server beta when measured; fail
closed instead of silently sampling or skipping rows. Revisit only with actual
scale evidence. No health-poll scan, global API read or verifier table is added.

Deferred: API-waits-for-worker boot ordering, retiring old master keys, provider
migration/rewrapping, external vault references, hot rotation across running
replicas, mounted-file key configuration and a management UI. Stored key versions and the existing provider
interface provide the seam for later work. Previous keys and separately retained
backup keys remain necessary until retirement support is explicitly designed.

## Sources and completion

The envelope approach follows [AWS's data-key model](https://docs.aws.amazon.com/kms/latest/developerguide/data-keys.html).
The generation, rotation, custody and recovery requirements are consistent with
[OWASP key-management guidance](https://cheatsheetseries.owasp.org/cheatsheets/Key_Management_Cheat_Sheet.html).
These sources establish the general practices; the concrete responsibilities
and startup limitations above come from the repository, not a vendor template.

Done when all four implementation slices pass their checks and CI, self-managed
deployment and separate-key recovery work through the supported sequence,
KMS remains compatible, and the ADR/runbook accurately describe both options
and the deferred migrations. Checked slices have passed local verification; their PRs record CI and merge.

Slice 1 local evidence: lint and TypeScript passed; integrations (459), API
(1,961) and worker (704) unit tests passed. Architecture/import checks and
unused-export checks passed. Production self-managed mode remained refused in that slice.

Slice 2 local evidence: lint, TypeScript, architecture and unused-export checks
passed; integrations (468), database (528) and worker (707) unit tests passed.
Six real PostgreSQL inventory/preflight tests cover 754 retained rows, snapshot
consistency, RLS, early exit, wire cancellation and safe CLI diagnostics. The
existing 30 operational-helper tests passed. Production self-managed mode is
still refused in that slice; API/worker startup remained independent.


Slice 3 local evidence: production configuration and Compose were checked in
both provider modes, including previous-key delivery, private env permissions,
API authority separation and refusal of an older self-managed target. Deploy
and restore command tests cover gate ordering, stopped serving on failure,
retained restore fences and compatible verification of older KMS rollback.

Verification also passed lint, TypeScript, formatting, architecture and unused-export
checks; integrations (470), API (1961), worker (707) unit tests and all 38
operational helper tests passed. The unchanged real recovery drill passed against
cached pinned storage/PostgreSQL images before extending it in slice 4.


Slice 4 local evidence: all retained connection and webhook secrets under two
private master-key versions survived the matched database/object recovery
point and opened through the existing cipher. Four fresh PostgreSQL targets
used the downloaded dump: the correct ring passed, a missing previous key and
wrong current bytes failed clearly, and webhook-only verification caught a
missing historical key. Provider switches were refused. The backup listing
contained only the existing fixed files and object tree, with neither encoded
nor decoded master-key bytes in the downloaded dump.

Both provider modes passed the packaged-helper rehearsal on a cached runtime
with the current compiled packages, including historical connection/webhook
crypto and safe preflight failure with networking disabled. The existing image
CI job runs the same helper against a complete production build. No images
were downloaded locally and no CI job, stored format, role or service was added.

Final regression evidence: full build, lint, TypeScript, formatting, unused-export,
architecture, schema and generated-contract checks passed; 8,557 unit tests, 788
database integration tests, 198 service integration tests, 144 mocked browser
tests and 40 operational-helper tests passed. Real KMS access, owner HTTPS
launch, remote backups and the measured owner restore drill remain beta slice 6.
API startup still does not wait for worker health; rewrap, provider migration,
key retirement and mounted-file key configuration remain deferred as agreed.

The final rollback check also passed against a cached older runtime: its own
compiled parser accepted KMS and refused self-managed configuration despite
verifier-file presence. Automatic rollback validates that policy in a private
temporary directory, cleans it on success/failure, and keeps the current
retained-key check before any restart. No configuration result marker is added.
