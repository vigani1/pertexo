import { isUniqueConstraintFailure } from '../../platform/query-errors.js';
import { SignInProofRejectedError } from './accounts/rejection.js';
import type { Pool } from 'pg';
import { withPlatformTransaction } from '../../tenant-access/transactions.js';
import { queryFailure } from '../../platform/query-errors.js';
import { completeSocialSignIn } from './complete.repository.js';
import type {
  ProvenSocialSignIn,
  SocialSignInAttempt,
  SocialSignInResult,
} from './contract.js';

/** A provider proves identity before this owner acquires a transaction. */
export class SocialSignInCommands {
  public constructor(
    private readonly input: Readonly<{ pool: Pool; sessionTtlSeconds: number }>,
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
    await this.input.pool.query(
      `insert into app.auth_sign_in_attempts(id,provider,state_digest,browser_digest,return_path,expires_at)
       values($1,$2,$3,$4,$5,clock_timestamp()+interval '5 minutes')`,
      [
        input.id,
        input.provider,
        input.stateDigest,
        input.browserDigest,
        input.returnPath,
      ],
    );
  }

  public async find(
    stateDigest: Buffer,
    browserDigest: Buffer,
  ): Promise<SocialSignInAttempt | undefined> {
    const row = (
      await this.input.pool.query<{
        id: string;
        provider: string;
        return_path: string;
      }>(
        `select id,provider,return_path from app.auth_sign_in_attempts
       where state_digest=$1 and browser_digest=$2 and consumed_at is null and expires_at>clock_timestamp()`,
        [stateDigest, browserDigest],
      )
    ).rows[0];
    return row === undefined
      ? undefined
      : { id: row.id, provider: row.provider, returnPath: row.return_path };
  }

  public complete(input: ProvenSocialSignIn): Promise<SocialSignInResult> {
    return withPlatformTransaction(this.input.pool, async (client) => {
      const result = await completeSocialSignIn(
        client,
        input,
        this.input.sessionTtlSeconds,
      );
      if (result.kind === 'failed') throw new SignInProofRejectedError();
      return result;
    }).catch((error: unknown) => {
      if (error instanceof SignInProofRejectedError)
        return { kind: 'failed' } as const;
      const cause = queryFailure(error);
      const uniqueConstraintFailure = isUniqueConstraintFailure(cause);
      if (uniqueConstraintFailure) return { kind: 'failed' } as const;
      throw error;
    });
  }
}
