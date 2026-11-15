import type { Pool, PoolClient } from 'pg';

import { withPlatformTransaction } from '@pertexo/database/platform';
import {
  hasPendingInvitation,
  hasVerifiedAccount,
  lockFirstAccount,
} from './sign-up.repository.js';

/** `invitation` closes sign-up once the install has its first verified account. */
export type SignUpMode = 'invitation' | 'open';

async function admits(
  client: PoolClient,
  mode: SignUpMode,
  email: string,
): Promise<boolean> {
  return (
    mode === 'open' ||
    !(await hasVerifiedAccount(client)) ||
    hasPendingInvitation(client, email)
  );
}

/**
 * Decides whether this address may become a working account, inside the
 * transaction that makes it one. Held to commit, the lock is what leaves one
 * winner when several people race to be an install's first account.
 */
export async function admitNewAccount(
  client: PoolClient,
  mode: SignUpMode,
  email: string,
): Promise<boolean> {
  if (mode === 'open') return true;
  await lockFirstAccount(client);
  return admits(client, mode, email);
}

/** What a form can tell someone before they fill it in; verification decides for real. */
export class SignUpAvailability {
  public constructor(
    private readonly pool: Pool,
    private readonly mode: SignUpMode,
  ) {}

  public admits(email: string): Promise<boolean> {
    return withPlatformTransaction(this.pool, (client) =>
      admits(client, this.mode, email),
    );
  }

  public async availableToEveryone(): Promise<boolean> {
    return (
      this.mode === 'open' ||
      !(await withPlatformTransaction(this.pool, hasVerifiedAccount))
    );
  }
}
