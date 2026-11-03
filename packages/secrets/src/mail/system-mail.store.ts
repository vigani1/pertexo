import {
  acquireDatabasePool,
  type DatabaseConfig,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import {
  claimMail,
  findUnavailableMailKey,
  insertSystemMail,
  settleMail,
} from './deliveries.repository.js';
import type {
  SystemMailClaimRequest,
  SystemMailInput,
  SystemMailSettlement,
} from './system-mail.types.js';

/*
 * No member stands behind either store, so neither goes through a workspace's
 * authority: an address can ask for mail before it has an account, and the worker
 * delivers across every workspace. A sealed payload is all they carry.
 */

export type SystemMailEnqueueStore = ReturnType<
  typeof createSystemMailEnqueueStore
>;
export type SystemMailDeliveryStore = ReturnType<
  typeof createSystemMailDeliveryStore
>;

export function createSystemMailEnqueueStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime, { role: 'api' });
  return Object.freeze({
    enqueue: (input: SystemMailInput): Promise<void> =>
      insertSystemMail(lease.pool, input),
    close: (): Promise<void> => lease.close(),
  });
}

export function createSystemMailDeliveryStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime, { role: 'worker' });
  return Object.freeze({
    claim: (input: SystemMailClaimRequest) => claimMail(lease.pool, input),
    settle: (input: SystemMailSettlement) => settleMail(lease.pool, input),
    close: (): Promise<void> => lease.close(),
  });
}

/** Startup refuses missing retained mail keys before any delivery can be claimed. */
export async function verifySystemMailKeys(
  config: DatabaseConfig,
  availableVersions: readonly string[],
): Promise<void> {
  const lease = acquireDatabasePool(config, undefined, { role: 'maintenance' });
  try {
    if (
      (await findUnavailableMailKey(lease.pool, availableVersions)) !==
      undefined
    )
      throw new Error(
        'Queued system mail needs an unavailable AUTH_MAIL_KEY version. Restore its AUTH_MAIL_PREVIOUS_KEYS entry before starting the worker.',
      );
  } finally {
    await lease.close();
  }
}
