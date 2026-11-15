import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { authSignInAttempts } from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { Pool } from 'pg';
import { completeSocialSignInCommand } from './complete-sign-in.js';
import type { SignUpMode } from '../../sign-up.js';
import type {
  ProvenSocialSignIn,
  SocialSignInAttempt,
  SocialSignInResult,
} from './social-sign-in.types.js';
import { MINUTE_INTERVAL } from '../../../shared/sql-intervals.repository.js';

// A social sign-in must come back from its provider within this.
const SOCIAL_SIGN_IN_LIFETIME_MINUTES = 5;
const SOCIAL_SIGN_IN_LIFETIME = sql`${SOCIAL_SIGN_IN_LIFETIME_MINUTES}*${MINUTE_INTERVAL}`;

/** A provider proves identity before this owner acquires a transaction. Nobody is signed in yet, so it stays off `withWorkspaceAccess`. */
export class SocialSignInCommands {
  public constructor(
    private readonly input: Readonly<{
      pool: Pool;
      sessionTtlSeconds: number;
      signUpMode: SignUpMode;
    }>,
  ) {}

  public async start(
    input: Readonly<{
      id: string;
      provider: string;
      stateDigest: Buffer;
      browserDigest: Buffer;
      returnPath: string;
    }>,
  ): Promise<void> {
    await drizzle(this.input.pool)
      .insert(authSignInAttempts)
      .values({
        ...input,
        expiresAt: sql`clock_timestamp()+${SOCIAL_SIGN_IN_LIFETIME}`,
      })
      .catch(rethrowQueryFailure);
  }

  public async find(
    stateDigest: Buffer,
    browserDigest: Buffer,
  ): Promise<SocialSignInAttempt | undefined> {
    const [row] = await drizzle(this.input.pool)
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

  public complete(input: ProvenSocialSignIn): Promise<SocialSignInResult> {
    return completeSocialSignInCommand(this.input.pool, input, this.input);
  }
}
