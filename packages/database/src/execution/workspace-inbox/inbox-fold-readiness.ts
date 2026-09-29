import type { Pool } from 'pg';

import { withPlatformTransaction } from '../../tenant-access/workspace.js';

// ADR 055: the fold and expiry commands must be the reviewed, owner-run
// bodies, executable by the worker and nobody else, and the worker must hold
// no other authority over the inbox tables.
const readinessSql = `select (
  current_user=$2::name
  and exists(select 1 from pg_roles role where role.rolname=current_user
    and not role.rolsuper and not role.rolbypassrls)
  and not pg_has_role(current_user,$1::name,'MEMBER')
  and not exists (
    select 1 from (values
      ('fold_workspace_inbox_events(integer)','899c9594fabccef911b6d08fa32a65cb'),
      ('expire_workspace_inbox_threads(integer)','9deadaa33d0fa9e847c4cdc4127a837c')
    ) required(signature,body_hash)
    where not exists (
      select 1 from pg_proc command
      where command.oid=to_regprocedure('app.'||required.signature)
        and pg_get_userbyid(command.proowner)=$1
        and command.prosecdef
        and md5(command.prosrc)=required.body_hash
        and command.proconfig=array['search_path=pg_catalog, app, pg_temp','row_security=on']
        and has_function_privilege(current_user,command.oid,'EXECUTE')
        and not exists (
          select 1 from aclexplode(coalesce(command.proacl,acldefault('f',command.proowner))) acl
          where acl.privilege_type='EXECUTE' and acl.grantee<>command.proowner
            and acl.grantee<>(select oid from pg_roles where rolname=$2::name))
    )
  )
  and has_table_privilege(current_user,'app.workspace_inbox_events','INSERT')
  and not has_table_privilege(current_user,'app.workspace_inbox_events','SELECT,UPDATE,DELETE,TRUNCATE')
  and not has_table_privilege(current_user,'app.workspace_inbox_threads','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
  and not has_table_privilege(current_user,'app.workspace_inbox_reads','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
) compatible`;

export async function checkWorkspaceInboxFoldReadiness(
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
        throw new Error('Workspace inbox fold authority is incompatible');
    },
    {
      ...(signal === undefined ? {} : { signal }),
      statementTimeoutMillis: 1_000,
    },
  );
}
