import type { PoolClient } from 'pg';

import { SignInProofRejectedError } from '../accounts/sign-in-proof.errors.js';

import type { DirectoryUserRow } from './resources/directory-resources.repository.js';

import type { DirectoryOrganization } from './directory-provisioning.types.js';

import { projectDirectoryMemberships } from './projection.repository.js';

import {
  linkDirectoryUser,
  readDirectorySignInRows,
} from './sign-in.repository.js';

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
  const rows = await readDirectorySignInRows(client, organizationId, {
    email,
    providerId,
    subject,
  });
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
  if (directory.user_id === null)
    await linkDirectoryUser(client, organization, directory, userId);
  await projectDirectoryMemberships(client, organization, { actorId: userId }, [
    directory.id,
  ]);
}
