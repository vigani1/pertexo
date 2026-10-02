# ADR063 — Verified historical origin for curated workflow templates

Status: accepted, 2026-10-02, by the roadmap manager after primary and independent
ADR/contract review and closure of the readiness/typed-validation clarifications.
Implementation is authorized; migration 0133 is allocated against reviewed
combined F02/F05 base `f5432838`, integrated normally in `69c10d3b`.
The curated-only HTTPS policy amendment at `fdfc5699` received exact-source
primary acceptance on 2026-10-02. Changed-policy implementation is authorized;
qualification remains open. Parent: [F06](../feature-plans/06-curated-templates.md).

Curated examples should accelerate setup without creating a second importer or
coupling an editable workflow to a changing asset. Decision: use F05's
existing atomic import command with optional, verified template origin, persist
bounded immutable historical evidence with the workflow, and expose it only on
an explicitly requested projection of the existing scoped workflow read. Never
infer origin from a client label, name, graph annotation or current resemblance.

## Approved product boundary

Technical first-time builders/operators; three bounded instructional examples
in the supported `validate_activation` profile (epoch 38 at the baseline).
Default `core` remains unsupported; no automatic cohort switch or production
deployment. Explicit destination bindings are required before creation under
[ADR062](062-portable-workflow-authoring.md). [ADR060](060-workflow-duplication-identity.md)
governs graph identity: new outer workflow ID, unchanged graph-local IDs,
mappings and dynamic expression text. Publish, run and activation remain
separate actions. The accepted contract below governs durable storage.

## Provenance contract

**Historical template origin** records a reviewed template basis and the
configured manifest admitted at its initial creation. It is not current graph
equivalence, safety certification, verified credentials, provider readiness or
automatic upgrade eligibility. A copied workflow can inherit historical origin
without claiming the copy currently matches the original template.

The optional strict `templateOrigin` request member contains only:

```json
{
  "schemaVersion": 1,
  "templateId": "controlled-http-notification",
  "templateVersion": 1,
  "baseManifestDigest": "<64 lowercase hexadecimal characters>"
}
```

IDs are reviewed ASCII kebab-case strings of 1–64 bytes; version is an integer
from 1 through 2,147,483,647; null/unknown keys are rejected. The placeholder
digest above illustrates the field, not a valid production descriptor.
Preview and import accept the same optional member. It is outside the strict
F05 manifest; no manifest format/version or export field changes.

The server resolves an owner-installed immutable descriptor, verifies its
base digest and all allowed setup transformations, and applies ordinary F05
admission, slot binding, serving fingerprint and authority checks. A matching
origin string alone is insufficient. Only two typed literal targets are initially
editable through guided setup: HTTP `config.url` and Slack
`inputMappings.channelId.value` in the third example. Slack's mapping must remain
`kind: literal`; it is not a config property. The first two examples use fixed
reviewed config and literal demo data. Name and destination bindings remain
ordinary import inputs. Any further allowed setup field requires descriptor
review/versioning; no generic JSON Patch, arbitrary mapping/expression edit or
silent normalization is allowed.

Typed setup validation has a deliberate browser-safe workflow-model interface,
with differential tests against registered server rules; no server integrations
are imported into the browser model. F05 portable catalog policy validates config
only, not Slack literal inputs. Slack must satisfy its registered input pattern
`^[CDGU][A-Z0-9]+$` intersected with the template's 2–128-character bound. HTTP
must satisfy its registered config rule and the narrower curated HTTPS endpoint
v1 grammar below: at most 2,048 UTF-8 bytes, no userinfo/fragment and no
credential-like query parameter names. Server origin verification checks these
typed rules as well as ordinary F05 config admission; SQL independently checks
the same curated grammar. This amendment changes the original full-WHATWG
acceptance expectation; it does not claim unchanged URL semantics.

### Curated HTTPS endpoint v1 amendment — accepted

On 2026-10-02 the human authorized the recommended option 3 through the roadmap
manager: narrow only curated-template setup, consistently across browser/model,
registered server admission and independent SQL validation. Do not add a general
URL parser, database extension or caller-trusted verification flag. The exact
grammar and differential acceptance matrix are specified in the
[contract](../feature-plans/06-template-origin-contract.md#curated-https-endpoint-v1-grammar).

Choose a lowercase `https://` scheme, lowercase ASCII DNS host (no Unicode,
punycode, IP literal, port or trailing dot), explicit absolute path and at most
16 `name=value` query pairs. Raw characters are ASCII only; path/query values
may use uppercase `%HH` byte escapes, but host/query names may not. Reject dot
path segments including `%2E` equivalents, every literal fragment marker and
userinfo delimiter, whitespace, controls and backslashes. Query names are
bounded unreserved ASCII and case-insensitively reject the existing credential
name pattern. No decoding/normalization of the admitted manifest occurs.

This deliberately excludes valid registered-node inputs such as Unicode/IDNA
hosts, `https:example.test`, explicit ports, empty `@`/`#` markers, encoded query
names and raw Unicode paths. Users may supply percent-encoded UTF-8 in path or
query values within the original byte ceiling; those bytes remain exact. The
ordinary HTTP node, F05 imports without origin, existing serving cohorts and
execution network policy are unchanged. URL syntax is not DNS reachability,
public-address safety, credential readiness or delivery proof.

Use descriptor value kind `curated_https_endpoint_v1` rather than silently
changing the unversioned `https_endpoint` meaning. Initial template version 1
and manifest digest can remain because this is a pre-release descriptor revision:
no authentic origin-bearing creation has been admitted, writers remain off and
all installed partial candidates were disposable qualification databases.
Regenerate/review descriptor targets and their inventory digest before the first
installation/acceptance. Future grammar changes require a new value-kind and
descriptor/template version; never mutate an installed descriptor or revalidate
retained exact replay under a new policy. Old commands without origin keep their
exact bytes/hash; origin-bearing replay remains ahead of policy checks.

Rationale: three bounded instructional examples do not justify introducing a
security-sensitive PostgreSQL native parser/custom image or maintaining a full
WHATWG/UTS46 implementation in SQL. Explicitly restricting new curated setup
keeps the SQL guard readily auditable and avoids permissive regex IDNA forgery.
The prior broad URL oracle at `b69a940b` remains historical evidence of the
compatibility change, not evidence that this narrower policy is implemented.
Primary accepted the exact three-document delta at `fdfc5699` before changed-policy
implementation. Genuine three-tier differential plus raw-role PostgreSQL tests
still precede enablement; design acceptance is not qualification evidence.

The canonical idempotent command includes the complete configured manifest,
name, bindings, compatibility fingerprint and exact optional origin. Omitted
origin must produce byte-for-byte unchanged F05 canonical command/hash; adding,
removing or changing origin with the same key conflicts. No full command or
setup values enter durable receipts, audit metadata or telemetry.

Persist one bounded origin record in the creation transaction, containing the
request origin fields plus server-computed `creationCommandDigest` and
`derivation: "direct"`. The digest is the existing verified canonical import
request hash, covering the full configured request including origin; it is
historical, not a digest of later edits. No URL/channel/input/connection ID,
actor/source-workspace ID, graph or
secret is duplicated into origin. Identifier-only import response stays unchanged.

## Reviewed descriptors and persistence seam

Reviewed browser-safe manifests/descriptors live under the existing
workflow-model package, through a deliberate browser-safe export. Node-catalog
continues to own registered config/catalog policy; web owns chooser/setup; API
and database continue to own F05 authority/atomic import. No new package, listing
endpoint, submission/admin registry or independent template command is created.

Use an owner-installed global descriptor relation for database guard
verification, not a mutable tenant catalog. Each unique `(template_id, version)`
has canonical bounded manifest text/digest, at most 16 setup targets and a
selection-enabled flag. Base content and allowed targets are immutable. Only
owner-controlled additive migrations install reviewed versions; no runtime role
can insert/update/delete content. API can read/lock descriptors, not administer
them. Selection removal changes only the enabled flag and browser selection;
retained content remains available for compatibility diagnostics. Descriptor
canonical bytes/digest must agree with repository assets in build/readiness
tests. There is no external loading or download at runtime.

Because descriptor `FOR SHARE` needs more than SELECT, use a confined
owner-owned security-definer read-lock helper, API-only execution, strict bounded
identity, fixed search path/row-security settings and readiness-pinned body/ACL.
It locks only the requested row in the existing transaction after authority
checks; no runtime content/selection mutation or general UPDATE grant. Privilege
and owner-selection/reader-lock tests must prove this confinement.

This relation is deliberate defense in depth: F05's security-definer SQL helper
already validates its raw command against a locked receipt. An origin-aware
helper must similarly check the owner-installed descriptor and permitted literal
delta; passing a caller-provided "verified" boolean would permit forged origin.
API pure policy and SQL guard must share generated descriptor evidence/tests,
not independently handwritten example graphs.

Origin records live in a separate workspace-scoped child relation keyed by
`(workspace_id, workflow_id)`, with the existing composite workflow foreign key
and delete cascade, RLS and least-privileged grants. Avoid adding a column to
`app.workflows`: current readers use `select *` with strict row schemas and older
images would fail on the new column. Origin has no runtime UPDATE grant, graph
revision dependency or mutable synchronization behavior. The scoped reader
projects it explicitly; no per-row loop/N+1 reads are needed.

Extend the existing import helper additively to support both exact old envelopes
and the bounded optional origin envelope; keep its signature and old F05 checks.
Install reader/guard compatibility before enabling the new writer. No second
transaction/browser write may attach origin after creation. See the
[concrete contract design](../feature-plans/06-template-origin-contract.md) for
lock order, failure model, reader projection and rollout gates.

## Read, edit, duplication and export policy

- Default workflow summary/list/write responses remain their exact strict F05
  shapes. An opt-in projection on existing `GET .../workflows/{workflowId}` uses
  `include=templateOrigin` and returns `{workflow, templateOrigin}`; origin is
  null only when the current reader authoritatively finds no origin. Unsupported
  old-reader projection is not interpreted as null. No listing backend is added.
  Use existing workflow-read/membership/workspace rules and scoped cache fencing;
  no extra permission or access to descriptor contents is implied.
- Rename, graph edits, version publication/restoration and workflow archive/
  restoration do not update/delete origin. UI says "Originally based on…", never
  "verified template". Origin survives asset selection removal and process
  restart independently of current descriptor lookup or graph contents.
- Ordinary same-workspace F05 duplication copies retained origin atomically
  under its existing source lock, marking `derivation: "inherited"`; it keeps
  the original creation-command digest, not a checksum of the copied edited graph.
  No source workflow/actor/tenant lineage identifier is exposed or retained.
  Duplicate request identity/response and old receipt replay remain unchanged.
  If the source has no origin the destination has none. Origin-copy compatibility
  must continue with template writer disabled, including a separately built and
  qualified older compatibility image, not an unmodified old image.
- Ordinary portable export contains no origin and does not change format V1.
  Importing that exported file creates a workflow without origin. Explicit
  selection of a reviewed template may produce verified origin only after the
  normal descriptor/config-delta checks. Similarity alone never grants origin.

## Recovery, retention and rollback

F05's actor/workspace-scoped completed receipt replay precedes new-writer,
descriptor-selection, catalog and connection checks; it returns the original
visible destination after current authority checks. Removed descriptors and
disabled writers cannot allocate a replacement or block retained exact replay.
Same-key different command conflicts, missing destination fails closed, and
existing terminal 24-hour receipt expiry/hold/purge rules remain unchanged.
Browser recovery retains the full frozen command only in scoped memory and
uses the repaired confirmed-only explicit fresh-import action; uncertain commands
never get a reset/new-key escape.

Workflow origin is workflow metadata, not an actor's import receipt. Removing a
member immediately denies disclosure/replay but does not erase shared workflow
origin. It follows existing workflow/workspace retention, legal-hold and bounded
purge behavior, cascading when the workflow is actually deleted. No new TTL,
retention quota, billing or actor retention dependency. Owner-installed public
descriptors contain no tenant data and remain retained when examples are retired;
they must never contain deployment endpoints, credentials or private channels.

Rollback first disables new template selection/writes, not ordinary F05 import.
Keep additive schema, descriptor rows, compatible import/duplication helpers,
origin readers and retained receipt logic. Old strict default API readers keep
working on the qualified compatibility image. Readiness continues to require the
exact migration head and pinned import/duplicate helper bodies; do not relax it.
Use a held-traffic migration-head cutover: stop/drain traffic, migrate with writers
off, deploy/qualify compatible-off at the new head/inventory, then release held
traffic. No unmodified old-image overlap is supported. An older compatibility
image is separately built/qualified for the new head/helper inventory, retains
old default read/duplication code where applicable, and includes origin-aware
parser/replay and retained origin reads. The contract's explicit local cutover
matrix must prove compatible-off → local enable → compatible-off rollback.
Once any origin command has been accepted, a pre-origin-parser image
is an incompatible rollback target for the import endpoint: stopping new writers
alone cannot recover retained origin-bearing commands. Roll back only to the
separately qualified compatible reader/parser/replay image with new writers
disabled. No down migration, destructive schema rollback or image that overwrites
the compatible helper is permitted.
Production enablement is not authorized by this ADR.

## Alternatives and costs

Assets-only onboarding would avoid API/storage work but fail the approved
durable origin/removal-read outcome. A new template service/marketplace adds
unneeded ownership and mutable lifecycle. Client-only origin or an unverified
string can lie; graph annotations couple user edits to metadata and pollute V1
exports. Adding fields to all strict summaries breaks old clients. Attaching
origin in a second write produces partial/orphan attribution after lost response.

The descriptor relation and SQL guard add migration/readiness and
retained compatibility obligations. Primary/independent design review is complete;
implementation and qualification tests remain required. Three complete normal-admission prototype
proofs are separately recorded; controlled live qualification remains required.
Pure compilation/config feasibility does not establish a usable or safe automation.
