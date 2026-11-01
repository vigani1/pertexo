import { isUniqueConstraintFailure } from '@pertexo/database/primitives';
import { hasSignInMethodCapacity } from './federation/accounts/limits.queries.js';
import { readEligibleAuthenticationSession } from './federation/sessions/authority.repository.js';
import { issueSession } from './federation/sessions/issue.repository.js';
import type { AuthenticationSession } from './federation/sessions/contract.js';
import { createHash, randomUUID } from 'node:crypto';

import { and, eq, gt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';

import {
  authAccounts,
  authMethodLinkAttempts,
  authSessions,
  users,
} from '@pertexo/database/schema';
import { withPlatformTransaction } from '@pertexo/database/platform';
import { recordIdentitySecurityFact } from './facts.repository.js';

type ProviderName = 'google' | 'github' | 'microsoft' | 'apple';
type ProviderIdentity = Readonly<{
  accountId: string;
  email: string | null;
  emailVerified: boolean;
}>;
type AccountLinkAttempt = typeof authMethodLinkAttempts.$inferSelect;
type LinkCompletion =
  { kind: 'failed' } | { kind: 'already' } | { kind: 'linked'; token: string };

/** Persists a browser-bound provider journey without owning its HTTP protocol. It concerns one person in no workspace, so it stays off `withWorkspaceAccess`. */
export class AccountLinkingCommands {
  public constructor(
    private readonly input: Readonly<{ pool: Pool; sessionTtlSeconds: number }>,
  ) {}

  public async hasMethod(userId: string, provider: string): Promise<boolean> {
    const rows = await drizzle(this.input.pool)
      .select({ id: authAccounts.id })
      .from(authAccounts)
      .where(
        and(
          eq(authAccounts.userId, userId),
          eq(authAccounts.providerId, provider),
        ),
      )
      .limit(1);
    return rows.length === 1;
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
    await drizzle(this.input.pool)
      .insert(authMethodLinkAttempts)
      .values({
        ...input,
        expiresAt: sql`clock_timestamp()+interval '5 minutes'`,
      });
  }

  public async find(
    stateDigest: Buffer,
  ): Promise<AccountLinkAttempt | undefined> {
    const [attempt] = await drizzle(this.input.pool)
      .select()
      .from(authMethodLinkAttempts)
      .where(
        and(
          eq(authMethodLinkAttempts.stateDigest, stateDigest),
          gt(authMethodLinkAttempts.expiresAt, sql`clock_timestamp()`),
        ),
      );
    return attempt;
  }

  public async updateSource(
    attempt: AccountLinkAttempt,
    {
      state,
      binding,
      identity,
      nextState,
    }: Readonly<{
      state: string;
      binding: string;
      identity: ProviderIdentity;
      nextState: string;
    }>,
  ): Promise<boolean> {
    return withPlatformTransaction(this.input.pool, async (client) => {
      const db = drizzle(client);
      const [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, attempt.userId), eq(users.status, 'active')))
        .for('update');
      if (
        user === undefined ||
        (await activeLinkSession(client, attempt)) === undefined
      )
        return false;
      const locked = await lockAttempt(client, attempt, state, binding);
      if (locked?.phase !== 'source') return false;
      const source = await db
        .select({ id: authAccounts.id })
        .from(authAccounts)
        .where(
          and(
            eq(authAccounts.userId, attempt.userId),
            eq(authAccounts.providerId, attempt.sourceProvider),
            eq(authAccounts.accountId, identity.accountId),
          ),
        );
      if (source.length !== 1) return false;
      // State is replaced before the next redirect; the old callback is dead.
      await db
        .update(authMethodLinkAttempts)
        .set({ phase: 'target', stateDigest: journeyDigest(nextState) })
        .where(eq(authMethodLinkAttempts.id, attempt.id));
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
    return withPlatformTransaction<LinkCompletion>(
      this.input.pool,
      async (client) => {
        const db = drizzle(client);
        const [user] = await db
          .select({ status: users.status })
          .from(users)
          .where(eq(users.id, attempt.userId))
          .for('update');
        const sourceSession = await activeLinkSession(client, attempt);
        if (user?.status !== 'active' || sourceSession === undefined)
          return { kind: 'failed' };
        const locked = await lockAttempt(client, attempt, state, binding);
        if (locked?.phase !== 'target') return { kind: 'failed' };
        const [owner] = await db
          .select({ userId: authAccounts.userId })
          .from(authAccounts)
          .where(
            and(
              eq(authAccounts.providerId, attempt.targetProvider),
              eq(authAccounts.accountId, identity.accountId),
            ),
          );
        if (owner !== undefined) {
          if (owner.userId !== attempt.userId) return { kind: 'failed' };
          await completeAttempt(client, attempt.id);
          return { kind: 'already' };
        }
        if (!(await hasSignInMethodCapacity(client, attempt.userId)))
          return { kind: 'failed' };
        await db.insert(authAccounts).values({
          id: randomUUID(),
          accountId: identity.accountId,
          providerId: attempt.targetProvider,
          userId: attempt.userId,
        });
        await recordIdentitySecurityFact(
          client,
          attempt.userId,
          'method.linked',
        );
        await db
          .delete(authSessions)
          .where(eq(authSessions.userId, attempt.userId));
        const token = await issueSession(
          client,
          attempt.userId,
          this.input.sessionTtlSeconds,
          sourceSession.proof,
        );
        await completeAttempt(client, attempt.id);
        return { kind: 'linked', token };
      },
    ).catch((error: unknown) => {
      // Drizzle wraps PostgreSQL failures; the constraint remains the arbiter
      // when two users finish a proof for the same provider account.
      if (isUniqueConstraintFailure(error)) return { kind: 'failed' };
      throw error instanceof Error
        ? error
        : new Error('Account linking failed');
    });
  }
}

async function activeLinkSession(
  client: PoolClient,
  attempt: AccountLinkAttempt,
): Promise<AuthenticationSession | undefined> {
  const rows = await drizzle(client)
    .select({ id: authSessions.id })
    .from(authSessions)
    .where(
      and(
        eq(authSessions.id, attempt.sessionId),
        eq(authSessions.userId, attempt.userId),
        gt(authSessions.expiresAt, sql`clock_timestamp()`),
      ),
    )
    .for('update');
  return rows.length === 1
    ? readEligibleAuthenticationSession(client, attempt.sessionId)
    : undefined;
}

async function lockAttempt(
  client: PoolClient,
  attempt: AccountLinkAttempt,
  state: string,
  binding: string,
): Promise<AccountLinkAttempt | undefined> {
  const [locked] = await drizzle(client)
    .select()
    .from(authMethodLinkAttempts)
    .where(
      and(
        eq(authMethodLinkAttempts.id, attempt.id),
        eq(authMethodLinkAttempts.stateDigest, journeyDigest(state)),
        gt(authMethodLinkAttempts.expiresAt, sql`clock_timestamp()`),
      ),
    )
    .for('update');
  const invalidJourneyBinding =
    locked?.userId !== attempt.userId ||
    locked.sessionId !== attempt.sessionId ||
    !locked.browserDigest.equals(journeyDigest(binding));
  if (invalidJourneyBinding) return undefined;
  return locked;
}

async function completeAttempt(client: PoolClient, id: string): Promise<void> {
  await drizzle(client)
    .update(authMethodLinkAttempts)
    .set({
      phase: 'completed',
      completedAt: sql`clock_timestamp()`,
      stateDigest: null,
    })
    .where(eq(authMethodLinkAttempts.id, id));
}

function journeyDigest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
