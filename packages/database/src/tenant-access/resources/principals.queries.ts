import type { PoolClient } from 'pg';
import type {
  SharingPrincipalsQuery,
  SharingPrincipals,
} from '@pertexo/contracts';
import { lockWorkspaceAuthority } from '../workspaces/authority.queries.js';
import { RESOURCE_ADMINISTRATORS } from './policy.js';
import type { ResourceActor } from './contract.js';
import type { Role } from '@pertexo/workflow-model';

/** Principal discovery is bounded and anchored to this workspace's current identities. */
export async function readSharingPrincipals(
  client: PoolClient,
  actor: ResourceActor,
  input: SharingPrincipalsQuery,
): Promise<SharingPrincipals> {
  await lockWorkspaceAuthority(
    client,
    actor.workspaceId,
    actor.actorId,
    RESOURCE_ADMINISTRATORS,
  );
  const parameters = [
    actor.workspaceId,
    input.search ?? null,
    input.after ?? null,
    input.limit + 1,
  ];
  const result = await client.query<{
    id: string;
    label: string;
    organization_id: string;
    email: string;
    role: Role;
  }>(
    input.kind === 'member'
      ? `select person.id,person.display_name label,person.email,member.role from app.workspace_memberships member
      join app.users person on person.id=member.user_id and person.status='active'
      where member.workspace_id=$1 and member.status='active' and ($2::text is null or position(lower($2) in lower(person.display_name))>0 or position(lower($2) in lower(person.email))>0)
        and ($3::uuid is null or person.id>$3) order by person.id limit $4`
      : `select directory.id,directory.display_name label,directory.organization_id
      from app.auth_organization_workspaces link join app.auth_directory_groups directory on directory.organization_id=link.organization_id
      where link.workspace_id=$1 and ($2::text is null or position(lower($2) in lower(directory.display_name))>0)
        and ($3::uuid is null or directory.id>$3) order by directory.id limit $4`,
    parameters,
  );
  const page = result.rows.slice(0, input.limit);
  return {
    items: page.map((row) =>
      input.kind === 'member'
        ? {
            kind: 'member',
            userId: row.id,
            label: row.label,
            email: row.email,
            role: row.role,
          }
        : {
            kind: 'group',
            organizationId: row.organization_id,
            groupId: row.id,
            label: row.label,
          },
    ),
    next: result.rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
  };
}
