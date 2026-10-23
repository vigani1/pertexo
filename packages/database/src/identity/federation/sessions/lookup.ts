import type { Pool, PoolClient } from 'pg';
import {
  accountPolicy,
  authenticationAllowed,
  FEDERATION_WORKSPACE_STATUSES,
  sessionProof,
  type StoredSessionProof,
} from './policy.js';

type SessionFacts = StoredSessionProof &
  Readonly<{
    status: string;
    email_verified: boolean;
    organization_id: string | null;
    require_sso: boolean | null;
    control_owner: boolean;
    password_present: boolean;
    provider_organization_id: string | null;
    provider_enabled: boolean | null;
    provider_revision: number | null;
    directory_allowed: boolean;
  }>;

/** The materialized scope precedes RLS reads and expires with this single statement. */
export async function isAuthenticationSessionAllowed(
  pool: Pool | PoolClient,
  sessionId: string,
): Promise<boolean> {
  const facts = (
    await pool.query<SessionFacts>(
      `
    with scoped_session as materialized (
      select session.user_id,session.authentication_method,
        session.federation_provider_id,session.federation_provider_revision,
        account.status,account.email_verified,domain.organization_id,domain.require_sso,
        set_config('app.workspace_id',coalesce(organization.control_workspace_id::text,''),true) workspace_scope
      from app.auth_sessions session
      join app.users account on account.id=session.user_id
      left join app.auth_domains domain on domain.domain=lower(split_part(account.email,'@',2)) and domain.verified_at is not null
      left join app.auth_organizations organization on organization.id=domain.organization_id
      where session.id=$1 and session.expires_at>clock_timestamp()
    )
    select session.*,
      exists(select 1 from app.workspace_memberships member
        join app.workspaces workspace on workspace.id=member.workspace_id
        where member.workspace_id=nullif(session.workspace_scope,'')::uuid
          and member.user_id=session.user_id and member.role='owner' and member.status='active') control_owner,
      (select count(*)=1 from app.auth_accounts account where account.user_id=session.user_id
        and account.provider_id='credential' and account.password is not null and length(account.password)>0) password_present,
      provider.organization_id provider_organization_id,provider.enabled provider_enabled,provider.revision provider_revision,
      coalesce(directory.active and directory.deleted_at is null,true) directory_allowed
    from scoped_session session
    left join lateral (
      select provider.organization_id,provider.enabled,provider.revision from app.auth_providers provider
      join app.auth_organizations organization on organization.id=provider.organization_id
      join app.workspaces control on control.id=organization.control_workspace_id
      where provider.id=session.federation_provider_id and control.status=any($2::text[])
    ) provider on true
    left join lateral (
      select active,deleted_at from app.auth_directory_users
      where organization_id=provider.organization_id and user_id=session.user_id
      order by (deleted_at is null) desc,created_at desc,id desc limit 1
    ) directory on true
  `,
      [sessionId, [...FEDERATION_WORKSPACE_STATUSES]],
    )
  ).rows[0];
  if (facts === undefined) return false;
  return authenticationAllowed(
    accountPolicy(facts),
    sessionProof(facts),
    facts.provider_organization_id === null || facts.provider_revision === null
      ? undefined
      : {
          organizationId: facts.provider_organization_id,
          enabled: facts.provider_enabled ?? false,
          revision: facts.provider_revision,
          directoryAllowed: facts.directory_allowed,
        },
  );
}
