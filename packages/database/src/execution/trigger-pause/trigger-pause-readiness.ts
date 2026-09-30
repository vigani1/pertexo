import type { Pool } from 'pg';

import { withPlatformTransaction } from '../../tenant-access/workspace.js';

// ADR 056: the fold must be the reviewed, owner-run body, executable by the
// worker and nobody else, and the worker must hold no other authority over
// the outcome and streak tables.
const readinessSql = `select (
  current_user=$2::name
  and exists(select 1 from pg_roles role where role.rolname=current_user
    and not role.rolsuper and not role.rolbypassrls)
  and not pg_has_role(current_user,$1::name,'MEMBER')
  and exists (
    select 1 from pg_proc command
    where command.oid=to_regprocedure('app.fold_workflow_trigger_outcomes(integer,boolean)')
      and pg_get_userbyid(command.proowner)=$1
      and command.prosecdef
      and md5(command.prosrc)='54c69650fa9bbf8c2580e0e86659e894'
      and command.proconfig=array['search_path=pg_catalog, app, pg_temp','row_security=on']
      and has_function_privilege(current_user,command.oid,'EXECUTE')
      and not exists (
        select 1 from aclexplode(coalesce(command.proacl,acldefault('f',command.proowner))) acl
        where acl.privilege_type='EXECUTE' and acl.grantee<>command.proowner
          and acl.grantee<>(select oid from pg_roles where rolname=$2::name))
  )
  and has_table_privilege(current_user,'app.workflow_trigger_outcomes','INSERT')
  and not has_table_privilege(current_user,'app.workflow_trigger_outcomes','SELECT,UPDATE,DELETE,TRUNCATE')
  and not has_table_privilege(current_user,'app.workflow_failure_streaks','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
) compatible`;

export async function checkWorkflowTriggerPauseReadiness(
  pool: Pool,
  ownerRole: string,
  workerRole: string,
  signal?: AbortSignal,
): Promise<void> {
  await withPlatformTransaction(
    pool,
    async (client) => {
      const result = await client.query<{ compatible: boolean }>(readinessSql, [
        ownerRole,
        workerRole,
      ]);
      if (result.rows[0]?.compatible !== true)
        throw new Error('Workflow trigger pause authority is incompatible');
    },
    {
      ...(signal === undefined ? {} : { signal }),
      statementTimeoutMillis: 1_000,
    },
  );
}
