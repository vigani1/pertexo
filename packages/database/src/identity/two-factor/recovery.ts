import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { DatabaseConfig } from '../../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../platform/pool/runtime.js';
import {insertSystemMail} from '../../platform/mail/repository.js';
import type { SystemMailInput } from '../../platform/mail/contract.js';
import { authTwoFactors } from '../../schema/authentication.js';
import { users } from '../../schema/foundation.js';
import { withPlatformTransaction } from '../../tenant-access/transactions.js';
import { recordIdentitySecurityFact } from '../security-facts.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';

type RecoveryUser = Readonly<{ email: string; displayName: string }>;
export type TwoFactorRecoveryResult = Readonly<{
  status: 'disabled' | 'already_off' | 'not_found';
  email: string;
}>;
export interface TwoFactorRecoveryStore {
  disable(
    email: string,
    prepareNotice: (user: RecoveryUser) => SystemMailInput | undefined,
  ): Promise<TwoFactorRecoveryResult>;
  close(): Promise<void>;
}

/** Global identity recovery uses the existing app login, not tenant or maintenance authority. */
export function createTwoFactorRecoveryStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): TwoFactorRecoveryStore {
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
            .where(sql`lower(${users.email}) = ${email}`)
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
