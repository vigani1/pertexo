import { canonicalEmail } from '@pertexo/workflow-model';
import { authAccounts } from '../../../schema/authentication.js';
import { authDirectoryUsers } from '../../../schema/identity/federation/directory/users.js';
import { authDirectoryMemberships } from '../../../schema/identity/federation/directory/sources.js';
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import { directoryUserRecords } from './resources/records.queries.js';
import { directoryUsers } from './resources/tables.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import type { PoolClient } from 'pg';
import { SignInProofRejectedError } from '../accounts/rejection.js';
import type { DirectoryUserRow } from './resources/records.queries.js';
import type { DirectoryOrganization } from './contract.js';
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
  const db = drizzle(client);
  const accounts = db
    .select({ id: authAccounts.userId })
    .from(authAccounts)
    .where(
      and(
        eq(authAccounts.providerId, providerId),
        eq(authAccounts.accountId, subject),
      ),
    );
  const rows = await directoryUserRecords(client)
    .where(
      and(
        eq(directoryUsers.organizationId, organizationId),
        or(
          eq(directoryUsers.loginEmail, canonicalEmail(email)),
          inArray(directoryUsers.userId, accounts),
        ),
      ),
    )
    .orderBy(
      desc(isNull(directoryUsers.deletedAt)),
      desc(directoryUsers.createdAt),
      desc(directoryUsers.id),
    )
    .catch(rethrowQueryFailure);
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
    await drizzle(client)
      .update(authDirectoryUsers)
      .set({
        userId,
        revision: sql`${authDirectoryUsers.revision}+1`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(authDirectoryUsers.organizationId, organization.id),
          eq(authDirectoryUsers.id, directory.id),
        ),
      )
      .catch(rethrowQueryFailure);
    // A deliberate recreation inherits only its own organization's old managed grants.
    for (const workspace of organization.workspaces)
      await withWorkspaceScope(
        client,
        { workspaceId: workspace.workspace_id },
        async (scoped) => {
          const prior = alias(authDirectoryUsers, 'prior');
          await drizzle(scoped)
            .update(authDirectoryMemberships)
            .set({ directoryUserId: directory.id })
            .from(prior)
            .where(
              and(
                eq(authDirectoryMemberships.organizationId, organization.id),
                eq(
                  authDirectoryMemberships.workspaceId,
                  workspace.workspace_id,
                ),
                eq(authDirectoryMemberships.userId, userId),
                eq(prior.id, authDirectoryMemberships.directoryUserId),
                isNotNull(prior.deletedAt),
              ),
            )
            .catch(rethrowQueryFailure);
        },
      );
  }
  await projectDirectoryMemberships(client, organization, { actorId: userId }, [
    directory.id,
  ]);
}
