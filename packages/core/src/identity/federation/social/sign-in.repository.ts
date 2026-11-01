import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { authSignInAttempts } from '@pertexo/database/schema';
import {
  rethrowQueryFailure,
  isUniqueConstraintFailure,
} from '@pertexo/database/primitives';
import { SignInProofRejectedError } from '../accounts/rejection.js';
import type { Pool } from 'pg';
import { withPlatformTransaction } from '@pertexo/database/platform';
import { completeSocialSignIn } from './complete.repository.js';
import type { SignUpMode } from '../../sign-up.js';
import type {
  ProvenSocialSignIn,
  SocialSignInAttempt,
  SocialSignInResult,
} from './contract.js';

/** A provider proves identity before this owner acquires a transaction. */
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
        expiresAt: sql`clock_timestamp()+interval '5 minutes'`,
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
    return withPlatformTransaction(this.input.pool, async (client) => {
      const result = await completeSocialSignIn(client, input, this.input);
      if (result.kind === 'failed') throw new SignInProofRejectedError();
      return result;
    }).catch((error: unknown) => {
      if (error instanceof SignInProofRejectedError)
        return { kind: 'failed' } as const;
      if (isUniqueConstraintFailure(error)) return { kind: 'failed' } as const;
      throw error;
    });
  }
}
