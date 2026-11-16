import type { PoolClient } from 'pg';

import { DirectoryError } from '../directory.errors.js';

import type { DirectoryOrganization } from '../directory-provisioning.types.js';

import { readDirectoryRole } from '../roles.repository.js';
import {
  readAdoptableDirectoryUser,
  readWorkspaceMember,
} from './adoption.repository.js';

import type {
  DirectoryAdoptionQuery,
  DirectoryAdoptionPreview,
} from '@pertexo/contracts';

import type { Role } from '@pertexo/policy';

type AdoptionCandidate = Readonly<{
  role: Role;
  status: string;
  managed: boolean;
}>;

/** Whether a membership can be adopted, with the refusal in words the owner reads. */
function judgeAdoption<Member extends AdoptionCandidate>(
  member: Member | undefined,
):
  | Readonly<{ eligible: true; member: Member }>
  | Readonly<{ eligible: false; reason: string }> {
  if (member?.role === 'owner')
    return {
      eligible: false,
      reason: 'Keep the recovery owner outside directory management.',
    };
  if (member?.status !== 'active')
    return {
      eligible: false,
      reason:
        'Only an active manual membership can be adopted. Reactivate an existing suspended or removed membership first.',
    };
  if (member.managed)
    return {
      eligible: false,
      reason: 'This membership is already directory-managed.',
    };
  return { eligible: true, member };
}

/** The preview is advisory; adoption rechecks every reviewed revision under write locks. */
export async function previewDirectoryAdoption(
  client: PoolClient,
  organization: DirectoryOrganization,
  {
    canManage,
    query,
  }: Readonly<{ canManage: boolean; query: DirectoryAdoptionQuery }>,
): Promise<DirectoryAdoptionPreview> {
  if (!canManage) throw new DirectoryError('forbidden');
  const workspace = organization.workspaces.find(
    (entry) => entry.workspace_id === query.targetWorkspaceId,
  );
  if (workspace === undefined) throw new DirectoryError('not_found');
  const directory = await readAdoptableDirectoryUser(
    client,
    organization.id,
    query.directoryUserId,
  );
  if (directory?.user_id === null || directory === undefined)
    return {
      eligible: false,
      reason:
        'This person must complete organization SSO before an existing membership can be adopted.',
    };
  const userId = directory.user_id;
  const member = await readWorkspaceMember(
    client,
    workspace.workspace_id,
    userId,
  );
  const judged = judgeAdoption(member);
  if (!judged.eligible) return judged;
  const role = await readDirectoryRole(client, organization.id, {
    workspaceId: workspace.workspace_id,
    directoryUserId: query.directoryUserId,
    fallback: workspace.default_role,
  });
  return {
    eligible: true,
    displayName: judged.member.display_name,
    currentRole: judged.member.role,
    command: {
      ...query,
      expectedRevision: organization.revision,
      directoryRevision: directory.revision,
      membershipRevision: judged.member.role_revision,
      role,
    },
  };
}
