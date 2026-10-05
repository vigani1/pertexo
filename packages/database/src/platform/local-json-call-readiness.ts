import type { Pool } from 'pg';
import { READINESS_WORKFLOW_CONCURRENCY_SQL } from './readiness-workflow-concurrency.sql.js';

// Only the two concurrency commands replaced by the installed local candidate.
// All other registered concurrency hashes, ACLs, policies and indexes stay exact.
export const LOCAL_JSON_CALL_CONCURRENCY_SQL =
  READINESS_WORKFLOW_CONCURRENCY_SQL.replace(
    '3c541c79eb4d3849b58d8c76a2c5fade',
    '4f2b5fe534190e0d4af122280a636775',
  )
    .replace(
      '9aa4c431740581a37d4873d0e49cc567',
      '02b0d390926624f0ea6d41ffe8ed92a5',
    )
    .replace(
      "'02b0d390926624f0ea6d41ffe8ed92a5','dispatcher','v',false",
      "'02b0d390926624f0ea6d41ffe8ed92a5','dispatcher','v',true",
    );
import type { DatabaseConfig } from '../config.js';
import type { CompatibilityReleaseExpectationSet } from '../compatibility/compatibility-release.js';
import { checkExpectedCompatibilityReleaseSet } from '../compatibility/compatibility-release.js';
import {
  assertDatabaseReadinessRow,
  DATABASE_READINESS_SQL,
  type ReadinessRow,
} from './readiness-probe.js';
import {
  EXPECTED_MIGRATION_HEAD,
  MINIMUM_POSTGRES_MAJOR,
  type DatabaseReadiness,
} from './readiness.js';

/** Isolated development fixture, never production native qualification. */
export function assertLocalJsonCallTarget(config: DatabaseConfig): void {
  const target = new URL(config.connectionString);
  if (
    process.env.NODE_ENV !== 'development' ||
    process.env.PERTEXO_LOCAL_JSON_CALL !== 'true' ||
    process.env.NODE_COMPATIBILITY_COHORT !== 'local_json_call' ||
    process.env.COMPOSE_PROJECT_NAME !==
      'pertexo-f08-local-json-call-20261005' ||
    target.hostname !== '127.0.0.1' ||
    target.port !== '51243' ||
    target.pathname !== '/pertexo' ||
    target.search !== ''
  )
    throw new Error(
      'Local JSON Call readiness requires the explicit owned development database',
    );
}

export async function checkLocalJsonCallReadiness(
  pool: Pool,
  config: DatabaseConfig,
  releases: CompatibilityReleaseExpectationSet,
): Promise<DatabaseReadiness> {
  assertLocalJsonCallTarget(config);
  const result = await pool.query<ReadinessRow>(DATABASE_READINESS_SQL, [
    config.ownerRole,
    config.workerRuntimeRole,
    'pertexo_api',
    'pertexo_maintenance',
    'pertexo_operator',
  ]);
  const row = result.rows[0];
  if (
    row === undefined ||
    !['pertexo_api', 'pertexo_worker'].includes(row.current_user)
  )
    throw new Error('Local JSON Call runtime identity is incompatible');
  // The candidate changes precisely these legacy capabilities. All other
  // registered-schema, identity, grants and alert baseline checks still apply.
  const native = await pool.query<{ compatible: boolean }>(
    `select (
    ${LOCAL_JSON_CALL_CONCURRENCY_SQL}
    and not exists (select 1 from unnest(array[
      'app.workflow_calls','app.workflow_execution_value_provenance',
      'app.workflow_execution_value_artifact_candidates','app.workflow_execution_value_artifact_associations'
    ]) name left join pg_class relation on relation.oid=to_regclass(name)
      where relation.oid is null or not relation.relrowsecurity or not relation.relforcerowsecurity
        or pg_get_userbyid(relation.relowner)<>$1
        or has_table_privilege(current_user,relation.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
    and not exists (select 1 from unnest(array[
      'record_native_root_execution_input','lock_workflow_call_admission',
      'record_workflow_call_outcome','record_native_workflow_attempt_output',
      'record_workflow_call_run_result','read_workflow_call_facts'
    ]) name where not exists (select 1 from pg_proc command join pg_namespace ns on ns.oid=command.pronamespace
      where ns.nspname='app' and command.proname=name and pg_get_userbyid(command.proowner)=$1
        and command.prosecdef and command.proconfig @> array['row_security=on']))
    and not exists (select 1 from unnest(array[
      'native_child_acceptance_complete','native_node_logical_projection_owned',
      'native_child_terminal_parent_wakeup','native_terminal_result_complete'
    ]) name where not exists (select 1 from pg_trigger trigger join pg_class relation on relation.oid=trigger.tgrelid
      join pg_namespace ns on ns.oid=relation.relnamespace
      where ns.nspname='app' and trigger.tgname=name and trigger.tgenabled='O'))
    and exists (select 1 from pg_attribute where attrelid='app.workflow_runs'::regclass
      and attname='native_initiating_actor_id' and atttypid='uuid'::regtype and not attisdropped)
    and exists (select 1 from pg_constraint where conrelid='app.workflow_versions'::regclass
      and conname='workflow_versions_schema_version_supported' and convalidated
      and pg_get_expr(conbin,conrelid) like '%wf:v3:sha256:%')
  ) compatible`,
    [config.ownerRole],
  );
  if (native.rows[0]?.compatible !== true)
    throw new Error('Local JSON Call six-owner schema is incompatible');
  assertDatabaseReadinessRow(
    {
      ...row,
      phase2_schema_compatible: true,
      phase3_schema_compatible: true,
      phase3_policy_compatible: true,
      execution_values_compatible: true,
      execution_admission_compatible: true,
    },
    {
      migrationHead: EXPECTED_MIGRATION_HEAD,
      minimumPostgresMajor: MINIMUM_POSTGRES_MAJOR,
      ownerRole: config.ownerRole,
    },
  );
  await checkExpectedCompatibilityReleaseSet(pool, releases);
  return Object.freeze({
    migrationHead: EXPECTED_MIGRATION_HEAD,
    postgresMajor: row.postgres_major,
    role: row.current_user,
  });
}
