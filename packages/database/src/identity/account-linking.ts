import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { recordIdentitySecurityFact } from './security-facts.js';

type ProviderName = 'google' | 'github' | 'microsoft' | 'apple';
type ProviderIdentity = Readonly<{
  accountId: string;
  email: string | null;
  emailVerified: boolean;
}>;
export type AccountLinkAttempt = Readonly<{
  id: string;
  user_id: string;
  session_id: string;
  browser_digest: Buffer;
  source_provider: string;
  target_provider: ProviderName;
  phase: 'source' | 'target' | 'completed' | 'abandoned';
  expires_at: Date;
}>;
export type LinkCompletion =
  { kind: 'failed' } | { kind: 'already' } | { kind: 'linked'; token: string };

export class AccountLinkingCommands {
  public constructor(
    private readonly input: Readonly<{ pool: Pool; sessionTtlSeconds: number }>,
  ) {}
  public async hasMethod(userId: string, provider: string): Promise<boolean> {
    const result = await this.input.pool.query(
      `select 1 from app.auth_accounts where user_id=$1 and provider_id=$2 limit 1`,
      [userId, provider],
    );
    return result.rowCount === 1;
  }
  public async start(
    input: Readonly<{
      id: string;
      userId: string;
      sessionId: string;
      browserDigest: Buffer;
      sourceProvider: string;
      targetProvider: ProviderName;
      phase: 'source' | 'target';
      stateDigest: Buffer;
    }>,
  ): Promise<void> {
    await this.input.pool.query(
      `insert into app.auth_method_link_attempts
        (id,user_id,session_id,browser_digest,source_provider,target_provider,
         phase,state_digest,expires_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+interval '5 minutes')`,
      [
        input.id,
        input.userId,
        input.sessionId,
        input.browserDigest,
        input.sourceProvider,
        input.targetProvider,
        input.phase,
        input.stateDigest,
      ],
    );
  }
  public async find(
    stateDigest: Buffer,
  ): Promise<AccountLinkAttempt | undefined> {
    const result = await this.input.pool.query<AccountLinkAttempt>(
      `select id,user_id,session_id,browser_digest,source_provider,
              target_provider,phase,expires_at
         from app.auth_method_link_attempts
        where state_digest=$1 and expires_at>clock_timestamp()`,
      [stateDigest],
    );
    return result.rows[0];
  }
  public async updateSource(
    attempt: AccountLinkAttempt,
    state: string,
    binding: string,
    identity: ProviderIdentity,
    nextState: string,
  ): Promise<boolean> {
    return inTransaction(this.input.pool, async (client) => {
      const user = await client.query(
        'select id from app.users where id=$1 and status=$2 for update',
        [attempt.user_id, 'active'],
      );
      if (
        user.rowCount !== 1 ||
        !(await this.sessionStillActive(client, attempt))
      )
        return false;
      const locked = await this.lockAttempt(client, attempt, state, binding);
      if (locked?.phase !== 'source') return false;
      const source = await client.query(
        `select 1 from app.auth_accounts
          where user_id=$1 and provider_id=$2 and account_id=$3`,
        [attempt.user_id, attempt.source_provider, identity.accountId],
      );
      if (source.rowCount !== 1) return false;
      // State is replaced before the next redirect; the old callback is dead.
      await client.query(
        `update app.auth_method_link_attempts
            set phase='target',state_digest=$2
          where id=$1`,
        [attempt.id, journeyDigest(nextState)],
      );
      return true;
    });
  }

  public async completeTarget(
    attempt: AccountLinkAttempt,
    state: string,
    binding: string,
    identity: ProviderIdentity,
  ): Promise<LinkCompletion> {
    if (!identity.emailVerified || identity.email === null)
      return { kind: 'failed' };
    return inTransaction<LinkCompletion>(this.input.pool, async (client) => {
      const user = await client.query<{ status: string }>(
        'select status from app.users where id=$1 for update',
        [attempt.user_id],
      );
      if (
        user.rows[0]?.status !== 'active' ||
        !(await this.sessionStillActive(client, attempt))
      )
        return { kind: 'failed' };
      const locked = await this.lockAttempt(client, attempt, state, binding);
      if (locked?.phase !== 'target') return { kind: 'failed' };
      const owner = await client.query<{ user_id: string }>(
        `select user_id from app.auth_accounts
          where provider_id=$1 and account_id=$2`,
        [attempt.target_provider, identity.accountId],
      );
      if (owner.rows[0] !== undefined) {
        if (owner.rows[0].user_id !== attempt.user_id)
          return { kind: 'failed' };
        await client.query(
          `update app.auth_method_link_attempts
              set phase='completed',completed_at=clock_timestamp(),state_digest=null
            where id=$1`,
          [attempt.id],
        );
        return { kind: 'already' };
      }
      await attachProviderMethod(client, {
        userId: attempt.user_id,
        providerId: attempt.target_provider,
        accountId: identity.accountId,
      });
      const token = await replaceBrowserSessions(
        client,
        attempt.user_id,
        this.input.sessionTtlSeconds,
      );
      await client.query(
        `update app.auth_method_link_attempts
            set phase='completed',completed_at=clock_timestamp(),state_digest=null
          where id=$1`,
        [attempt.id],
      );
      return { kind: 'linked', token };
    }).catch((error: unknown) => {
      if (isUniqueViolation(error)) return { kind: 'failed' };
      throw error instanceof Error
        ? error
        : new Error('Account linking failed');
    });
  }

  private async sessionStillActive(
    client: PoolClient,
    attempt: AccountLinkAttempt,
  ): Promise<boolean> {
    const session = await client.query(
      `select 1 from app.auth_sessions
        where id=$1 and user_id=$2 and expires_at>clock_timestamp()
        for update`,
      [attempt.session_id, attempt.user_id],
    );
    return session.rowCount === 1;
  }

  private async lockAttempt(
    client: PoolClient,
    attempt: AccountLinkAttempt,
    state: string,
    binding: string,
  ): Promise<AccountLinkAttempt | undefined> {
    const result = await client.query<AccountLinkAttempt>(
      `select id,user_id,session_id,browser_digest,source_provider,
              target_provider,phase,expires_at
         from app.auth_method_link_attempts
        where id=$1 and state_digest=$2 and expires_at>clock_timestamp()
        for update`,
      [attempt.id, journeyDigest(state)],
    );
    const locked = result.rows[0];
    if (
      locked?.user_id !== attempt.user_id ||
      locked.session_id !== attempt.session_id ||
      !locked.browser_digest.equals(journeyDigest(binding))
    )
      return undefined;
    return locked;
  }
}
async function inTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Attaches a provider account proven in this journey and audits it. */
async function attachProviderMethod(
  client: PoolClient,
  input: Readonly<{
    userId: string;
    providerId: string;
    accountId: string;
  }>,
): Promise<void> {
  await client.query(
    `insert into app.auth_accounts(id,account_id,provider_id,user_id)
     values($1,$2,$3,$4)`,
    [randomUUID(), input.accountId, input.providerId, input.userId],
  );
  await recordIdentitySecurityFact(client, input.userId, 'method.linked');
}

/**
 * Revokes every Better Auth session of the user and mints the single
 * replacement session token that the journey delivers to its browser.
 */
async function replaceBrowserSessions(
  client: PoolClient,
  userId: string,
  sessionTtlSeconds: number,
): Promise<string> {
  await client.query('delete from app.auth_sessions where user_id=$1', [
    userId,
  ]);
  const token = randomBytes(32).toString('base64url');
  await client.query(
    `insert into app.auth_sessions(id,expires_at,token,user_id)
     values($1,clock_timestamp()+($2::integer*interval '1 second'),$3,$4)`,
    [randomUUID(), sessionTtlSeconds, token, userId],
  );
  return token;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}

function journeyDigest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
