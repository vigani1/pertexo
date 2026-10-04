import type { Pool } from 'pg';
import { withPlatformReadClient } from '../../tenant-access/workspace.js';
import { assertNativeCoordinatorPoolAdmission } from './coordinator-executable-capability.js';
import {
  NATIVE_COORDINATOR_OWNER_INVENTORY,
  UNFINISHED_NATIVE_OWNER_INTEGRATIONS,
} from './coordinator-native-owner-inventory.js';
import { NATIVE_PUBLISHED_CONSTRAINT_INVENTORY } from './coordinator-native-published-constraints.js';

/** Infrastructure catalog only: no workspace, payload, writes or installation. */
export async function checkNativeCoordinatorReadiness(
  pool: Pool,
  ownerRole: string,
  workerRole: string,
  controlReadTimeoutMillis: number,
  signal?: AbortSignal,
): Promise<void> {
  assertNativeCoordinatorPoolAdmission(
    pool.options.connectionTimeoutMillis,
    controlReadTimeoutMillis,
  );
  // Exact body expectations cannot substitute for unfinished production owners.
  if (
    UNFINISHED_NATIVE_OWNER_INTEGRATIONS.length > 0 ||
    NATIVE_PUBLISHED_CONSTRAINT_INVENTORY.some(
      (constraint) => constraint.qualifiedExpressionMd5 === null,
    )
  )
    throw new Error('Native coordinator owner inventory is incomplete');
  await withPlatformReadClient(
    pool,
    async (client) => {
      const result = await client.query<{ compatible: boolean }>(
        `select (current_user=$2::name
        and exists(select 1 from pg_roles role where role.rolname=current_user
          and not role.rolsuper and not role.rolbypassrls)
        and not pg_has_role(current_user,$1::name,'MEMBER')
        and not exists (
          select 1 from jsonb_to_recordset($3::jsonb)
            expected(signature text,hash text,"securityDefiner" boolean,"rowSecurity" boolean)
          left join pg_proc command on command.oid=to_regprocedure(expected.signature)
          where command.oid is null or pg_get_userbyid(command.proowner)<>$1
            or command.prosecdef<>expected."securityDefiner"
            or md5(command.prosrc)<>expected.hash
            or command.proconfig is distinct from case when expected."rowSecurity"
              then array['search_path=pg_catalog, app, pg_temp','row_security=on']
              else array['search_path=pg_catalog, app, pg_temp'] end
        )
        and not exists (
          select 1 from jsonb_to_recordset($4::jsonb)
            expected(relation text,name text,"qualifiedExpressionMd5" text)
          left join pg_constraint binding on binding.conrelid=to_regclass(expected.relation)
            and binding.conname=expected.name
          where binding.oid is null or binding.contype<>'c' or not binding.convalidated
            or md5(pg_get_expr(binding.conbin,binding.conrelid)) is distinct from expected."qualifiedExpressionMd5"
        )
        and not exists (
          select 1 from unnest(array[
            'app.workflow_calls','app.workflow_execution_value_provenance',
            'app.workflow_execution_value_artifact_candidates',
            'app.workflow_execution_value_artifact_associations'
          ]) name
          left join pg_class relation on relation.oid=to_regclass(name)
          where relation.oid is null or not relation.relrowsecurity or not relation.relforcerowsecurity
            or pg_get_userbyid(relation.relowner)<>$1
            or has_table_privilege(current_user,relation.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            or has_any_column_privilege(current_user,relation.oid,'SELECT,INSERT,UPDATE,REFERENCES')
        )
      ) compatible`,
        [
          ownerRole,
          workerRole,
          JSON.stringify(NATIVE_COORDINATOR_OWNER_INVENTORY),
          JSON.stringify(NATIVE_PUBLISHED_CONSTRAINT_INVENTORY),
        ],
      );
      if (result.rows.length !== 1 || result.rows[0]?.compatible !== true)
        throw new Error(
          'Native coordinator registered owner inventory is incompatible',
        );
    },
    {
      ...(signal === undefined ? {} : { signal }),
      nativeReadBudget: {
        readTimeoutMillis: controlReadTimeoutMillis,
        controlReadTimeoutMillis,
      },
    },
  );
}
