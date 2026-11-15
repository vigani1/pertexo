import { canonicalEmail } from '../../email-policy.js';
import {
  authAccounts,
  authDirectoryUsers,
  authDirectoryMemberships,
} from '@pertexo/database/schema';
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
import { directoryUserRecords } from './resources/directory-resources.repository.js';
import { directoryUsers } from './resources/tables.js';
import {
  rethrowQueryFailure,
  withWorkspaceScope,
} from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import type { DirectoryUserRow } from './resources/directory-resources.repository.js';
import type { DirectoryOrganization } from './directory-provisioning.types.js';

/** Directory users matching the email or already bound to the provider subject, live first. */
export async function readDirectorySignInRows(
  client: PoolClient,
  organizationId: string,
  {
    email,
    providerId,
    subject,
  }: Readonly<{ email: string; providerId: string; subject: string }>,
): Promise<DirectoryUserRow[]> {
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
  return rows;
}

/** Binds the directory user to the person, and moves their earlier managed grants to it. */
export async function linkDirectoryUser(
  client: PoolClient,
  organization: DirectoryOrganization,
  directory: DirectoryUserRow,
  userId: string,
): Promise<void> {
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
              eq(authDirectoryMemberships.workspaceId, workspace.workspace_id),
              eq(authDirectoryMemberships.userId, userId),
              eq(prior.id, authDirectoryMemberships.directoryUserId),
              isNotNull(prior.deletedAt),
            ),
          )
          .catch(rethrowQueryFailure);
      },
    );
}
