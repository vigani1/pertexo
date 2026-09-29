import type { Pool } from 'pg';

import { withPlatformTransaction } from '../../tenant-access/workspace.js';

// Exact owned bodies/grants are a feature readiness gate, not activation.
const readinessSql = `select (
  current_user=$2::name
  and exists(select 1 from pg_roles role where role.rolname=current_user and not role.rolsuper and not role.rolbypassrls)
  and not pg_has_role(current_user,$1::name,'MEMBER') and not exists (
    select 1 from (values
      ('workspace_inbox_source_checksum(uuid,uuid,bigint,character varying,timestamp with time zone)',false,'5a3a3a24c419f65eecaf12adceea809f'),
      ('claim_workspace_inbox_capture(uuid,uuid,uuid,character,character varying,uuid)',true,'b1cda63e763198ed809e3c4698201733'),
      ('validate_workspace_inbox_delivery(uuid,uuid,uuid,character)',false,'b016a9578997b63206d73e736fd4e7ec'),
      ('capture_workspace_inbox_audience(uuid,uuid,uuid,bigint)',true,'ad72a29599abc45282e2df8753e3a677'),
      ('fail_workspace_inbox_capture(uuid,uuid,uuid,bigint)',true,'fc12ee49f86d43b2b3560a84d469d8fd')
    ) required(signature,definer,body_hash)
    where not exists (
      select 1 from pg_proc command where command.oid=to_regprocedure('app.'||required.signature)
        and pg_get_userbyid(command.proowner)=$1
        and command.prosecdef=required.definer and md5(command.prosrc)=required.body_hash
        and command.proconfig=case when required.definer or required.signature='validate_workspace_inbox_delivery(uuid,uuid,uuid,character)' then array['search_path=pg_catalog, app','row_security=on'] else array['search_path=pg_catalog'] end
        and not exists (select 1 from aclexplode(coalesce(command.proacl,acldefault('f',command.proowner))) acl where acl.grantee=0 and acl.privilege_type='EXECUTE')
        and has_function_privilege(current_user,command.oid,'EXECUTE')=required.definer
        and not exists (select 1 from aclexplode(coalesce(command.proacl,acldefault('f',command.proowner))) acl
          where acl.privilege_type='EXECUTE' and acl.grantee<>command.proowner
            and (not required.definer or acl.grantee<>(select oid from pg_roles where rolname=$2::name)))
    )
  )
) compatible`;

export async function checkInboxCaptureReadiness(
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
        throw new Error('Inbox capture command authority is incompatible');
    },
    {
      ...(signal === undefined ? {} : { signal }),
      statementTimeoutMillis: 1_000,
    },
  );
}
