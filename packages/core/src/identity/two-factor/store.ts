import type { RecoveryUser, TwoFactorRecoveryResult } from './contract.js';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { DatabaseConfig } from '@pertexo/database/platform';
import type { SystemMailInput } from '@pertexo/secrets/server';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
  withPlatformTransaction,
} from '@pertexo/database/platform';
import { insertSystemMail } from '@pertexo/secrets/server';
import { authTwoFactors, users } from '@pertexo/database/schema';
import { canonicalEmailSql } from '../canonical-email.js';
import { recordIdentitySecurityFact } from '../facts.repository.js';
import { rethrowQueryFailure } from '@pertexo/database/primitives';

export type TwoFactorRecoveryStore = ReturnType<
  typeof createTwoFactorRecoveryStore
>;

/** Global identity recovery uses the existing app login, not tenant or maintenance authority: an operator acts, not a member, so it stays off `withWorkspaceAccess`. */
export function createTwoFactorRecoveryStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime, { role: 'api' });
  return Object.freeze({
    disable: async (
      email: string,
      prepareNotice: (user: RecoveryUser) => SystemMailInput | undefined,
    ) =>
      withPlatformTransaction(
        lease.pool,
        async (client): Promise<TwoFactorRecoveryResult> => {
          const db = drizzle(client);
          const [user] = await db
            .select({
              id: users.id,
              email: users.email,
              displayName: users.displayName,
              enabled: users.twoFactorEnabled,
            })
            .from(users)
            .where(
              eq(
                canonicalEmailSql(users.email),
                canonicalEmailSql(sql.param(email)),
              ),
            )
            .for('update');
          if (user === undefined) return { status: 'not_found', email };
          const removed = await db
            .delete(authTwoFactors)
            .where(eq(authTwoFactors.userId, user.id))
            .returning({ id: authTwoFactors.id });
          if (!user.enabled && removed.length === 0)
            return { status: 'already_off', email: user.email };
          const notice = prepareNotice(user);
          await db
            .update(users)
            .set({ twoFactorEnabled: false, updatedAt: sql`clock_timestamp()` })
            .where(eq(users.id, user.id));
          await recordIdentitySecurityFact(
            client,
            user.id,
            'two_factor.operator_disabled',
          );
          if (notice !== undefined) await insertSystemMail(client, notice);
          return { status: 'disabled', email: user.email };
        },
      ).catch(rethrowQueryFailure),
    close: () => lease.close(),
  });
}
