import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import { drizzle } from 'drizzle-orm/node-postgres';

import { authSignInAttempts } from '@pertexo/database/schema';

import { rethrowQueryFailure } from '@pertexo/database/primitives';

import type { Pool } from 'pg';

import type { SocialSignInAttempt } from './social-sign-in.types.js';
import { MINUTE_INTERVAL } from '../../../shared/sql-intervals.repository.js';

// A social sign-in must come back from its provider within this.
const SOCIAL_SIGN_IN_LIFETIME_MINUTES = 5;
const SOCIAL_SIGN_IN_LIFETIME = sql`${SOCIAL_SIGN_IN_LIFETIME_MINUTES}*${MINUTE_INTERVAL}`;

export async function insertSocialSignInAttempt(
  pool: Pool,
  input: Readonly<{
    id: string;
    provider: string;
    stateDigest: Buffer;
    browserDigest: Buffer;
    returnPath: string;
  }>,
): Promise<void> {
  await drizzle(pool)
    .insert(authSignInAttempts)
    .values({
      ...input,
      expiresAt: sql`clock_timestamp()+${SOCIAL_SIGN_IN_LIFETIME}`,
    })
    .catch(rethrowQueryFailure);
}

export async function findSocialSignInAttempt(
  pool: Pool,
  stateDigest: Buffer,
  browserDigest: Buffer,
): Promise<SocialSignInAttempt | undefined> {
  const [row] = await drizzle(pool)
    .select({
      id: authSignInAttempts.id,
      provider: authSignInAttempts.provider,
      returnPath: authSignInAttempts.returnPath,
    })
    .from(authSignInAttempts)
    .where(
      and(
        eq(authSignInAttempts.stateDigest, stateDigest),
        eq(authSignInAttempts.browserDigest, browserDigest),
        isNull(authSignInAttempts.consumedAt),
        gt(authSignInAttempts.expiresAt, sql`clock_timestamp()`),
      ),
    )
    .catch(rethrowQueryFailure);
  return row;
}
