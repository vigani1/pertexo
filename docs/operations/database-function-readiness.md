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

The executable inventory is split between
`packages/database/src/platform/readiness.ts` (compatibility-release functions)
and `packages/database/src/platform/readiness-probe-3.sql.ts` (the preview pin
guard), with the workspace inbox fold and expiry commands in
`packages/database/src/execution/workspace-inbox/inbox-fold-readiness.ts` and
the trigger pause fold (ADR 056) in
`packages/database/src/execution/trigger-pause/trigger-pause-readiness.ts`,
which the worker checks at startup. The operational pause command is checked by
`packages/database/src/platform/readiness-probe-auto-pause.sql.ts`.
This table is an operator aid and must
change in the same commit whenever an owning inventory changes.

## Synchronized update procedure

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
