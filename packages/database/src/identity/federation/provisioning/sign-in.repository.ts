import type { PoolClient } from 'pg';
import { SignInProofRejectedError } from '../accounts/rejection.js';
import type { DirectoryUserRow } from './contract.js';
import type { DirectoryOrganization } from './authority.repository.js';
import { projectDirectoryMemberships } from './projection.repository.js';
import { withWorkspaceScope } from '../../../tenant-access/transactions.js';

/** A directory email is authorization to await SSO, never proof of account ownership. */
export async function directorySignInCandidate(
  client: PoolClient,
  organizationId: string,
  {
    email,
    providerId,
    subject,
  }: Readonly<{ email: string; providerId: string; subject: string }>,
): Promise<DirectoryUserRow | undefined> {
  const rows = (
    await client.query<DirectoryUserRow>(
      `select directory.* from app.auth_directory_users directory
     where organization_id=$1 and (login_email=$2 or user_id in (
       select user_id from app.auth_accounts where provider_id=$3 and account_id=$4))
     order by (deleted_at is null) desc,created_at desc,id desc`,
      [organizationId, email.toLowerCase(), providerId, subject],
    )
  ).rows;
  const live = rows.filter((row) => row.deleted_at === null);
  if (live.length > 1) throw new SignInProofRejectedError();
  const candidate = live[0] ?? rows[0];
  const directoryUserInactive =
    candidate !== undefined &&
    (!candidate.active || candidate.deleted_at !== null);
  if (directoryUserInactive) throw new SignInProofRejectedError();
  return candidate;
}

/** Called only after verified provider proof and the existing global-account check. */
export async function bindDirectorySignIn(
  client: PoolClient,
  organization: DirectoryOrganization,
  directory: DirectoryUserRow,
  userId: string,
): Promise<void> {
  if (directory.user_id !== null && directory.user_id !== userId)
    throw new SignInProofRejectedError();
  if (directory.user_id === null) {
    await client.query(
      'update app.auth_directory_users set user_id=$3,revision=revision+1,updated_at=clock_timestamp() where organization_id=$1 and id=$2',
      [organization.id, directory.id, userId],
    );
    // A deliberate recreation inherits only its own organization's old managed grants.
    for (const workspace of organization.workspaces)
      await withWorkspaceScope(
        client,
        { workspaceId: workspace.workspace_id },
        async (scoped) => {
          await scoped.query(
            `update app.auth_directory_memberships source set directory_user_id=$3
        from app.auth_directory_users prior where source.organization_id=$1 and source.workspace_id=$2 and source.user_id=$4
        and prior.id=source.directory_user_id and prior.deleted_at is not null`,
            [organization.id, workspace.workspace_id, directory.id, userId],
          );
        },
      );
  }
  await projectDirectoryMemberships(client, organization, { actorId: userId }, [
    directory.id,
  ]);
}
