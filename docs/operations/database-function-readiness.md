# Database Function Readiness

Startup compatibility deliberately verifies the exact PostgreSQL function body
stored in `pg_proc.prosrc` for security- and compatibility-critical functions.
The recurring readiness probe does not run these catalog checks. For these
interpreted/string-body functions, `prosrc` is PostgreSQL's stored source text,
not a formatting-normalized representation. Formatting-only edits can therefore
change `md5(prosrc)` and remain operational changes that block startup.

## Hashed function inventory

| Function | Expected MD5 | Security mode | Owning migration |
| --- | --- | --- | --- |
| `app.reject_preview_run_pin_change()` | `e3e80198979101aabfc681553bcdbedf` | invoker, `pg_catalog, pg_temp` | `0070_preview_execution_deadline.sql` |
| `app.enforce_phase3_core_executor_non_removal()` | `338c35d21e71957aed153ac764b2e450` | invoker, `pg_catalog, app` | `0018_phase3_core_executor_non_removal.sql` |
| `app.prepare_node_compatibility_release(integer,character varying,jsonb,integer,character varying,character varying,character varying,character varying)` | `cdc8c35b360133824aa9f2722c240934` | definer, `pg_catalog, app` | `0019_node_compatibility_preactivation.sql` |
| `app.lock_node_compatibility_current_supported(jsonb)` | `f76fa13098d07326e52621ae076882d6` | definer, `pg_catalog, app` | `0019_node_compatibility_preactivation.sql` |
| `app.record_node_compatibility_preactivation(uuid,character varying,integer,character varying,character varying,character varying,jsonb)` | `1cd8c85bfd2342dd954686fffc341238` | definer, `pg_catalog, app` | `0019_node_compatibility_preactivation.sql` |
| `app.approve_node_compatibility_activation(uuid,character varying,integer,character varying,jsonb,jsonb,character varying,character varying)` | `07e8e75948b469026b72060a33810e65` | definer, `pg_catalog, app` | `0019_node_compatibility_preactivation.sql` |
| `app.activate_node_compatibility_release(uuid,integer,character varying,uuid,character varying,character varying,character varying)` | `bc6581fed30a75832fdf7133613f355e` | definer, `pg_catalog, app` | `0019_node_compatibility_preactivation.sql` |
| `app.node_compatibility_artifact_set_valid(jsonb)` | `1ee6b6a001eb02b6b5a95f671240ae69` | invoker, `pg_catalog, app` | `0019_node_compatibility_preactivation.sql` |
| `app.compatibility_preactivation_cohort_complete(character varying,integer,character varying,character varying,jsonb)` | `4bd8e8a005eebc013d41ae6b6a55b976` | invoker, `pg_catalog, app` | `0019_node_compatibility_preactivation.sql` |
| `app.fold_workspace_inbox_events(integer)` | `899c9594fabccef911b6d08fa32a65cb` | definer, `pg_catalog, app, pg_temp`, `row_security=on`, worker-only | `0123_workspace_inbox_threads.sql` |
| `app.expire_workspace_inbox_threads(integer)` | `9deadaa33d0fa9e847c4cdc4127a837c` | definer, `pg_catalog, app, pg_temp`, `row_security=on`, worker-only | `0123_workspace_inbox_threads.sql` |
| `app.fold_workflow_trigger_outcomes(integer,boolean)` | `54c69650fa9bbf8c2580e0e86659e894` | definer, `pg_catalog, app, pg_temp`, `row_security=on`, worker-only | `0125_workflow_auto_pause_controls.sql` |
| `app.workflow_auto_pause_control(uuid,uuid,uuid,text,jsonb,text,text,text,text)` | `2ce8ab04731f24bd9292bdc7cf9e4079` | definer, `pg_catalog, app, pg_temp`, `row_security=on`, API-only | `0125_workflow_auto_pause_controls.sql` |
| `app.schedule_claim_workflow_paused(uuid,uuid,timestamptz)` | `7f7b9cf2e74f7e45644cd0fe3d37b205` | definer, `pg_catalog, app, pg_temp`, `row_security=on`, API/worker-only | `0125_workflow_auto_pause_controls.sql` |
| `app.workspace_reserved_active_slot_count(uuid)` | `6ed33604664c79cbc928094e4ada3202` | definer, stable, `pg_catalog, app, pg_temp`, `row_security=on`, API-only | `0126_workspace_usage_capacity.sql` |
| `app.enforce_workflow_run_admission()` | `4a178a6940d2a28eb9afde6f5227fbaf` | definer, `pg_catalog, app`, `row_security=on`, internal trigger | `0127_workflow_concurrency.sql` |
| `app.workflow_concurrency_admissible(uuid,uuid,boolean)` | `3c541c79eb4d3849b58d8c76a2c5fade` | definer, `pg_catalog, app, pg_temp`, `row_security=on`, internal | `0127_workflow_concurrency.sql` |
| `app.workflow_concurrency_control(uuid,uuid,uuid,text,jsonb,text,text,text,text)` | `f37e4d9d93e59b518d37713078575eda` | definer, `pg_catalog, app, pg_temp`, `row_security=on`, API-only | `0127_workflow_concurrency.sql` |
| `app.workflow_run_admission_blockers(uuid,uuid)` | `f0127382f587223639b4bfb02f120ee8` | definer, stable, `pg_catalog, app, pg_temp`, `row_security=on`, API-only | `0127_workflow_concurrency.sql` |
| `app.workflow_run_active_capacity_available(uuid,integer,uuid)` | `66e1c3ed4d6d458c4889799733c11063` | definer, `pg_catalog, app`, `row_security=on`, worker-only | `0127_workflow_concurrency.sql` |
| `app.rebind_workflow_run_active_admission(uuid,uuid,uuid,uuid)` | `8ff6b3bf9c4140076f4a16b80f0949a3` | definer, `pg_catalog, app`, `row_security=on`, worker-only | `0127_workflow_concurrency.sql` |
| `app.workflow_run_active_admission_eligible(uuid,uuid,uuid)` | `9aa4c431740581a37d4873d0e49cc567` | definer, `pg_catalog, app`, `row_security=on`, dispatcher-only | `0127_workflow_concurrency.sql` |
| `app.reserve_workflow_run_active_admission(uuid,uuid,uuid)` | `e11cf9af2c42e62f995138c7483fe162` | definer, `pg_catalog, app`, `row_security=on`, dispatcher-only | `0127_workflow_concurrency.sql` |
| `app.lock_notification_connection(uuid,uuid)` | `a12fd79c0d2753ff214e864732ed1ca3` | definer, `pg_catalog, app`, `row_security=on`, API/worker-only | `0128_connection_health.sql` |
| `app.enforce_connection_health_protocol()` | `4b36377613e407ba046e8c9c8f9ee824` | invoker, `pg_catalog, app`, internal trigger | `0128_connection_health.sql` |
| `app.cleanup_connection_health_command()` | `3356eaa54a79e4c96e55d258621c6fea` | definer, `pg_catalog, app`, `row_security=on`, internal trigger | `0128_connection_health.sql` |
| `app.bind_node_attempt_connection_dispatch(uuid,uuid,text,bigint,uuid,uuid)` | `a63cdd2cf7a8e9c967b992f9df28ed30` | definer, `pg_catalog, app`, `row_security=on`, worker-only | `0128_connection_health.sql` |
| `app.record_node_attempt_connection_health(uuid,uuid,text,bigint,text,text,text,uuid,uuid)` | `abded4cdf7da724dce322df3801262c5` | definer, `pg_catalog, app`, `row_security=on`, worker-only | `0128_connection_health.sql` |
| `app.apply_connection_health_observation(uuid,uuid,text,uuid,text)` | `2a15128a645b16ac211456c880d2cfd2` | definer, `pg_catalog, app`, `row_security=on`, worker-only | `0128_connection_health.sql` |
| `app.audit_connection_secret_access(uuid,uuid,uuid,text,text,text,text)` | `62ddece0876f51039e5825ac914246d3` | definer, `pg_catalog, app`, `row_security=on`, worker-only | `0128_connection_health.sql` |
| `app.apply_workspace_deletion_side_effects()` | `908becdc3d5fbf1ec9a1a855c97c75bf` | definer, `pg_catalog, app, pg_temp`, `row_security=on`, internal trigger | `0128_connection_health.sql` |
| `app.reject_retention_batch_direct_mutation()` | `bd7d508fdf10cf97eb33467e8bd00f37` | invoker, `pg_catalog, pg_temp`, internal trigger | `0128_connection_health.sql` |
| `app.create_workflow_duplicate_draft(uuid,uuid,uuid,uuid,character varying,integer,jsonb,character,character,text,uuid)` | `cca6cf717f5528c781f30c2460fe9dca` | definer, `pg_catalog, pg_temp`, `row_security=on`, API-only | `0133_curated_template_origin.sql` |
| `app.lock_workflow_portable_version(uuid,uuid,uuid,uuid)` | `00c1b41bf997942d194f9af7819f4d15` | definer, `pg_catalog, pg_temp`, `row_security=on`, API-only scoped read lock | `0132_workflow_portability.sql` |
| `app.create_workflow_import_draft(uuid,uuid,uuid,jsonb,character,character,text)` | `b6a6e87c4bed5ae35b3edc927a40f4e4` | definer, `pg_catalog, pg_temp`, `row_security=on`, API-only | `0133_curated_template_origin.sql` |
| `app.guard_curated_template_descriptor()` | `6e0fd4efae62132ea0312d9d99496039` | invoker, `pg_catalog, pg_temp`, internal trigger | `0133_curated_template_origin.sql` |
| `app.curated_template_inventory_matches(text)` | `c24b77c0f824bd4701e2afa88404cd90` | definer, stable, `pg_catalog, pg_temp`, `row_security=on`, API/worker-only boolean | `0133_curated_template_origin.sql` |
| `app.lock_curated_template_descriptor(text,integer)` | `f9f5e6053b93a8900abe09fe5e624bba` | definer, `pg_catalog, pg_temp`, `row_security=on`, API-only | `0133_curated_template_origin.sql` |
| `app.curated_https_endpoint_valid(text)` | `dde56c7e4aca9c64bd745c80be97e8d5` | invoker, immutable, `pg_catalog, pg_temp`, owner-only | `0133_curated_template_origin.sql` |
| `app.verify_curated_template_origin(jsonb,jsonb,text)` | `e7a60281a1a81b56a085ff72c4bf8bf4` | definer, `pg_catalog, pg_temp`, `row_security=on`, owner-only | `0133_curated_template_origin.sql` |
| `app.guard_workflow_input_case_write()` | `a3108e59e200d8e251cf39c056f41dd9` | definer, `pg_catalog, pg_temp`, `row_security=on`, internal trigger | `0130_workflow_input_cases.sql` |
| `app.reap_workflow_input_cases(integer)` | `f5a5951bcb6a7d913dac66dc15702e25` | definer, `pg_catalog, pg_temp`, `row_security=on`, maintenance-only | `0130_workflow_input_cases.sql` |
| `app.execute_workspace_tenant_rows_page_before_organization(uuid,uuid,bigint,integer,bigint,character)` | `348588ea384effc589d6c8c74686aa58` | definer, `pg_catalog, pg_temp`, `row_security=on`, owner-only retained body | `0130_workflow_input_cases.sql` |
| `app.execute_workspace_tenant_rows_page_before_folders(uuid,uuid,bigint,integer,bigint,character)` | `04650e6c8360b75173a63d34265f7aa0` | definer, `pg_catalog, pg_temp`, `row_security=on`, owner-only retained body | `0134_workflow_organization.sql` |
| `app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,character)` | `c19d0d7f7d347550eba8c52564144a86` | definer, `pg_catalog, pg_temp`, `row_security=on`, maintenance-only | `0135_workflow_folders_batch_identity.sql` |
| `app.execute_workflow_folder_command(text,uuid,text,jsonb)` | `ecfc968efc4600e3da617848ecf3742d` | definer, `pg_catalog, pg_temp`, `row_security=on`, API-only | `0135_workflow_folders_batch_identity.sql` |
| `app.admit_workflow_organization_batch(text,jsonb)` | `fefeaa5b268b5cabf83939bc5ef12da5` | definer, `pg_catalog, pg_temp`, `row_security=on`, API-only | `0135_workflow_folders_batch_identity.sql` |
| `app.execute_workflow_folder_placement(uuid,text,jsonb)` | `61a15b76b135ee03615f79ee90014c10` | definer, `pg_catalog, pg_temp`, `row_security=on`, API-only | `0135_workflow_folders_batch_identity.sql` |
| `app.execute_workflow_organization_batch_item(text,jsonb,uuid,text)` | `22c72a807734ddb1cca778b55584ee57` | definer, `pg_catalog, pg_temp`, `row_security=on`, API-only | `0135_workflow_folders_batch_identity.sql` |
| `app.lock_manual_workflow_run_start(uuid,uuid,text,text)` | `e70f076dbfffbb8a79b4534b49bdc138` | definer, `pg_catalog, pg_temp`, `row_security=on`, API-only | `0131_checked_manual_start.sql` |
| `app.enforce_manual_start_writer()` | `a24d51f06dfe43548064394c9bf03ca9` | invoker, `pg_catalog, pg_temp`, internal trigger | `0131_checked_manual_start.sql` |
| `app.assert_workflow_input_cases_enabled()` | `f537940438bedfc091e8a19b64c01689` | definer, `pg_catalog, pg_temp`, `row_security=on`, API-only | `0131_checked_manual_start.sql` |
| `app.prune_manual_start_rejections(integer)` | `490686b5af7560b8c7d0a6f526762fe2` | definer, `pg_catalog, pg_temp`, `row_security=on`, maintenance-only | `0131_checked_manual_start.sql` |

The executable inventory is split between
`packages/database/src/platform/readiness.ts` (compatibility-release functions)
and `packages/database/src/platform/readiness-probe-3.sql.ts` (the preview pin
guard), with the workspace inbox fold and expiry commands in
`packages/database/src/execution/workspace-inbox/inbox-fold-readiness.ts` and
the trigger pause fold (ADR 056) in
`packages/database/src/execution/trigger-pause/trigger-pause-readiness.ts`,
which the worker checks at startup. The operational pause command is checked by
`packages/database/src/platform/readiness-probe-auto-pause.sql.ts`.
The scoped workspace reservation-count reader (ADR 057) is checked by
`packages/database/src/platform/readiness-probe-4.sql.ts`, including its exact
tenant guard/count body, ownership, security configuration, API-only execution
grant, lack of API reservation-row privileges, and workspace index.
This table is an operator aid and must
change in the same commit whenever an owning inventory changes.

The organization boundary (ADR064) is catalog-only at startup in
`packages/database/src/platform/readiness-workflow-organization.sql.ts`. Head
0135 pins 11 relations, 30 function ABIs and 29 exact function bodies/security/ACL
contracts, with normalized catalog SHA-256
`9827f9fecb4e4c69185428ce253e57728fde64996d6469455f6bccdc317ad4ea`.
All 0134 bodies remain pinned unchanged; its former public purge body is retained
as the owner-only `before_folders` alias. The independent writer is not a schema
readiness input. Migration 0135 closes an already enabled writer during the
held-traffic upgrade, and never enables it; compatible reads and admitted exact
replays do not authorize new batch items while the writer is OFF. Follow the
accepted [folder/batch contract](../feature-plans/07-folders-bulk-follow-on-proposal.md).

The queue-only workflow concurrency boundary (ADR 058) is shared by API/worker
admission startup and dispatcher startup in
`packages/database/src/platform/readiness-workflow-concurrency.sql.ts`. It pins
the seven bodies above, security configuration, runtime execution ACLs, private
policy/receipt RLS and ACLs, ticket/reservation columns, private ticket sequence,
and exact scoped active/order index shapes. Follow the lock and rollout contract
in [Workflow concurrency enforcement](workflow-concurrency-enforcement.md).

The connection-health boundary (ADR059) is checked by
`packages/database/src/platform/readiness-connection-health.sql.ts`, included in
the API/worker compatibility probe. It pins the eight bodies above, exact
execution grants, private evidence tables and column grants, forced tenant RLS,
source-cascade constraints, command cleanup, and transition/revision constraints.
Follow [Connection health enforcement](connection-health-enforcement.md) for
lock order, mode-preserving backlog handling, and fail-closed mixed-version
deployment. Restore-before-serve uses the same migration-head compatibility
boundary; restoring evidence does not authorize enabling enforcement.

The atomic same-workspace duplication creator (ADR060) is checked by
`packages/database/src/platform/readiness-workflow-duplication.sql.ts` in the
startup compatibility probe. Its exact body, owner, security configuration and
API-only execution ACL are pinned. Migration 0129 is additive: apply it before
serving the new API; no existing creation function, runtime INSERT privilege or
receipt lifecycle is replaced. The exact migration-head contract does not admit
0128 images against 0129: hold serving traffic closed until all serving and
restore images accept 0129. This is not a zero-downtime mixed-head rollout.
Application rollback requires an image qualified against 0129; it may leave the
capability installed. Do not remove it while a supported image uses it, or rewrite
migration history to admit an older image.

Portable authoring (ADR062) is checked by
`packages/database/src/platform/readiness-workflow-portability.sql.ts` in the
same startup probe. It pins both API-only function bodies, owner, security
configuration and execution ACLs, plus ownership and API read/immutable-singleton
column grants on the default-off writer gate. Missing gate authority fails new
imports closed; export and preview are independent readers. The version reader
locks the exact scoped immutable version without granting API UPDATE on versions.
The creator hashes a transient canonical command containing only the exact
submitted manifest, bindings, normalized name and original catalog fingerprint;
workspace and actor are independently guarded transaction/receipt scopes. It
compares the rebound graph against that command and never persists its contents.

Apply additive 0132 before serving the feature image, with traffic held closed
until API, worker, dispatcher and restore images accept that exact head. This
branch qualifies the 0129-to-0132 path; 0130/0131 belong to concurrent F02 and are
not copied or renumbered here. Integration with that release must retain their
checksums and qualify the combined prior-head suffix. No mixed-head rolling
overlap is claimed. Reader availability is not writer activation: enabling the
gate requires a separately authorized deployment decision, not a migration
default. Rollback first disables new imports; exact authorized completed replay
is resolved before gate/catalog/binding checks. Use an image qualified for 0132,
leave imported normal workflows and the additive helpers readable, and retain
the existing 24-hour receipt reaper, legal holds and bounded workspace erasure.
No production activation is authorized.

The ADR061 case and checked-start boundary is checked by
`packages/database/src/platform/readiness-workflow-input-cases.sql.ts` and
`packages/database/src/platform/readiness-manual-start.sql.ts`. Migration 0130
installs bounded case storage and lifecycle functions; 0131 installs the shared
manual-command lock, rejection receipts, and all-manual-writer insertion fence.
The rollout row defaults to disabled. Migration-head readiness requires 0131
for all serving and restore images, and the insertion fence rejects predecessor
manual writers even when cases are disabled. Keep serving closed while applying
both migrations and replacing incompatible images. Only an operator may enable
cases after qualifying the complete deployment; this repository's isolated
fixtures do not authorize production enablement. Rollback uses an image qualified
against 0131 with cases disabled, not an older migration head. Preserve retained
receipts and held payloads; do not rewrite migration history.

Case cleanup acquires the destruction lock before workspace authority and quota
locks. Workspace purge retains the existing coordinator's dedicated-client
session destruction lock; its transaction must not reacquire that same lock on a
second client. Both paths recheck workspace legal holds before deleting data.

Case writers set the transaction-local writer marker only after current
authority, command-key, workflow and quota locks. The case trigger rejects a
markerless direct write before waiting for those locks, including raw UPDATE
paths that have already acquired the case row lock.

The combined ADR061/ADR062 image requires the ordered `0130`/`0131`/`0132`
history and exact migration head `0132_workflow_portability.sql`, with both
capability inventories intact. The individual release prerequisites above are
historical boundaries, not permission to serve an `0131` image at combined head
`0132`. Hold traffic until serving and restore images are qualified against the
combined head; leave both new writer gates disabled until separately authorized.

## Synchronized update procedure

ADR063 advances the exact head to `0133_curated_template_origin.sql` under held
traffic, retaining all combined F02/F05 capability checks. Unmodified 0132 images
are not compatible with that head. The curated writer remains off by default;
both API and worker pin the helper above and immutable inventory digest
`b2c003431f093031cdaebb97b78f8a9ddae81f8ce5fa14efd4035b639a3e9f75`.
Its canonical length-prefixed encoding is specified in the
[F06 contract](../feature-plans/06-template-origin-contract.md); mutable selection
flags are excluded. Worker gains no descriptor SELECT/DML or descriptor-lock
execution. Qualification of new-head compatible/off, owned enablement and
compatible/off rollback remains required; inventory code alone is not cutover proof.

All startup roles retain the exact curated schema, helper-body and ACL metadata
checks. After that audit, API/worker alone invoke the bounded inventory witness
on the same connection, selected by the database's actual `current_user`.
Dispatcher and other roles receive no helper execution grant. Their metadata
query must not reference the confined helper, even inside `CASE`: PostgreSQL can
require execution permission before evaluating that branch. Missing, false,
malformed or errored API/worker inventory results fail readiness closed.

1. Treat any body edit, including formatting, as a forward-only database
   compatibility change. Do not edit a published migration.
2. Prefer a new function signature or name when a zero-downtime rolling overlap
   is required. Keep the predecessor callable until the supported overlap is
   retired.
3. Add a new migration with the replacement body, owner, `SECURITY DEFINER`
   mode, fixed `search_path`, grants, and public-execute revocation.
4. Apply the migration to a disposable database and obtain the authoritative
   value with `select md5(prosrc) from pg_proc where oid =
   'app.<signature>'::regprocedure`. Copy that exact value into startup
   compatibility and this inventory.
5. Add or update the exact prior-head-to-head migration test. For compatibility
   release functions, retain the one-predecessor rolling-overlap test and prove
   both API and worker cohorts before activation.
6. Run the focused drift tests, the zero/prior-head database matrix, and
   `pnpm check`. Review the migration and application change as one release
   unit.
7. The release job applies migrations before serving tasks start. If an
   in-place replacement cannot support both application versions, hold traffic
   closed until the new API and worker startup compatibility checks pass. Do not
   mix an old image with a body hash it does not recognize.

### Patching a function by text

Some migrations change an existing function by reading its body with
`pg_get_functiondef`, replacing a marker, and executing the result, so each
feature adds its lines without copying the whole function. From migration 0123
on, every such replacement must first count its marker and raise unless it
occurs exactly once; a presence check alone lets a marker that later appears
twice receive the change twice or in the wrong place.
`packages/database/test/migration-function-patching.test.ts` enforces this.
Published migrations before 0123 keep their original presence checks and must
not be edited.

## Failure and rollback

A hash mismatch is a startup compatibility failure, not a liveness failure.
Keep the service out of rotation and compare `pg_get_functiondef`, owner,
language, `prosecdef`, `proconfig`, and grants against the reviewed migration.
Do not weaken or bypass the hash check to restore traffic.

Database rollback is forward-only. Add a reviewed repair migration that restores
the previously approved body and security attributes, verify its authoritative
hash, then deploy an application image whose inventory accepts that body. For a
rolling overlap, retire the replacement only after persisted compatibility
state and both serving cohorts no longer require it. Never rewrite migration
history or run an unreviewed `CREATE OR REPLACE FUNCTION` in production.

Current regression coverage includes exact drift rejection for the preview pin
guard and Phase 3 non-removal guard, full preactivation authority validation,
the bounded one-predecessor compatibility-release overlap, and zero/prior-head
migration suites. Every future supported rolling release must add its own
prior-head fixture before the predecessor is admitted.

## Ordinary draft format cutover

The registered `0136_workflow_draft_graph_v2.sql` migration enables editable
Graph V2 source only. Startup readiness separately checks draft support `[1, 2]`,
the exact validated schema/header constraints, and the registered head. Published
graphs remain V1; executable graphs remain V2. No native runtime routines,
catalog entries, grants or writer activation are included.

Do not use this change as a zero-downtime or mixed-image compatibility release.
The exact-head check does not fence already-running older processes. An
authorized operator must hold writes/traffic closed, drain old API/worker and
other serving cohorts, apply the registered migration through the normal runner,
and start synchronized compatible images. Reopen only after all serving startup
checks pass and ordinary retained/native draft GET/conditional-save checks pass.
Keep native execution/catalog/writers and native Publish/Run disabled. A failing
constraint validation is a failed cutover, not permission to use `NOT VALID`,
rewrite source, drop checks or weaken readiness.

After V2 drafts exist, rollback must retain a reader/image supporting both draft
formats and this exact head, or use a reviewed forward repair. Do not deploy an
older V1-only reader or downgrade stored drafts to make it start. This procedure
documents a release requirement; the local draft-storage checkpoint does not
authorize deployment or qualify the paused native security/runtime gates.
