import { randomUUID } from 'node:crypto';

import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';

import { authEmailProofs, authSessions } from '../schema/authentication.js';
import { users } from '../schema/foundation.js';
import { withPlatformTransaction } from '../tenant-access/transactions.js';
import {
  insertAuthenticationMail,
  type AuthenticationMailInput,
} from './authentication-mail.js';
import { rethrowIdentityQueryFailure } from './query-errors.js';
import { recordIdentitySecurityFact } from './security-facts.js';

type ProofPurpose = 'initial_verification' | 'change_old' | 'change_new';
type ProofUser = Readonly<{ id: string; email: string; name: string }>;

/** Locks the user before issuing or consuming a single-use email proof. */
export class EmailProofCommands {
  public constructor(private readonly pool: Pool) {}

  public async issue(
    user: ProofUser,
    purpose: 'initial_verification' | 'change_old',
    tokenDigest: Buffer,
    newEmail: string | undefined,
    expiresAt: Date,
    prepared: AuthenticationMailInput | undefined,
  ): Promise<boolean> {
    return withPlatformTransaction(this.pool, async (client) => {
      const db = drizzle(client);
      const [current] = await db
        .select()
        .from(users)
        .where(eq(users.id, user.id))
        .for('update');
      if (
        current?.status !== 'active' ||
        current.email.toLowerCase() !== user.email.toLowerCase() ||
        current.emailVerified !== (purpose === 'change_old')
      )
        return false;
      await db.insert(authEmailProofs).values({
        id: randomUUID(),
        tokenDigest,
        userId: user.id,
        purpose,
        email: user.email,
        newEmail: newEmail ?? null,
        expiresAt: expiresAt.toISOString(),
      });
      if (prepared !== undefined)
        await insertAuthenticationMail(client, prepared);
      return true;
    }).catch(rethrowIdentityQueryFailure);
  }

  public async inspect(tokenDigest: Buffer) {
    const [proof] = await drizzle(this.pool)
      .select({
        purpose: authEmailProofs.purpose,
        newEmail: authEmailProofs.newEmail,
        displayName: users.displayName,
      })
      .from(authEmailProofs)
      .innerJoin(users, eq(users.id, authEmailProofs.userId))
      .where(
        and(
          eq(authEmailProofs.tokenDigest, tokenDigest),
          isNull(authEmailProofs.consumedAt),
          gt(authEmailProofs.expiresAt, sql`clock_timestamp()`),
          eq(users.status, 'active'),
          sql`lower(${users.email}) = lower(${authEmailProofs.email})`,
        ),
      );
    return proof;
  }

  public async consume(
    tokenDigest: Buffer,
    next: Readonly<{ digest: Buffer; expiresAt: Date }> | undefined,
    nextMail: AuthenticationMailInput | undefined,
  ): Promise<ProofPurpose | 'invalid'> {
    return withPlatformTransaction(this.pool, (client) =>
      consumeProof(client, tokenDigest, next, nextMail),
    ).catch(rethrowIdentityQueryFailure);
  }
}

/** Consumes a proof only while it still refers to the user's current address. */
async function consumeProof(
  client: PoolClient,
  tokenDigest: Buffer,
  next: Readonly<{ digest: Buffer; expiresAt: Date }> | undefined,
  nextMail: AuthenticationMailInput | undefined,
): Promise<ProofPurpose | 'invalid'> {
  const db = drizzle(client);
  const [owner] = await db
    .select({ userId: authEmailProofs.userId })
    .from(authEmailProofs)
    .where(eq(authEmailProofs.tokenDigest, tokenDigest));
  if (owner === undefined) return 'invalid';
  const userId = owner.userId;
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .for('update');
  if (user?.status !== 'active') return 'invalid';
  const [row] = await db
    .select({
      proof: authEmailProofs,
      usable: sql<boolean>`${authEmailProofs.consumedAt} is null and ${authEmailProofs.expiresAt} > clock_timestamp()`,
    })
    .from(authEmailProofs)
    .where(eq(authEmailProofs.tokenDigest, tokenDigest))
    .for('update');
  if (
    row?.usable !== true ||
    row.proof.userId !== userId ||
    row.proof.email.toLowerCase() !== user.email.toLowerCase()
  )
    return 'invalid';
  const proof = row.proof;
  let outcome: ProofPurpose;
  if (proof.purpose === 'initial_verification') {
    if (user.emailVerified) return 'invalid';
    await db
      .update(users)
      .set({ emailVerified: true, updatedAt: sql`clock_timestamp()` })
      .where(eq(users.id, userId));
    await db.delete(authSessions).where(eq(authSessions.userId, userId));
    await recordIdentitySecurityFact(client, userId, 'email.initial_verified');
    outcome = proof.purpose;
  } else if (proof.purpose === 'change_old') {
    if (!user.emailVerified || next === undefined || proof.newEmail === null)
      return 'invalid';
    await db.insert(authEmailProofs).values({
      id: randomUUID(),
      tokenDigest: next.digest,
      userId,
      purpose: 'change_new',
      email: proof.email,
      newEmail: proof.newEmail,
      expiresAt: next.expiresAt.toISOString(),
    });
    if (nextMail !== undefined)
      await insertAuthenticationMail(client, nextMail);
    await recordIdentitySecurityFact(client, userId, 'email.old_confirmed');
    outcome = proof.purpose;
  } else if (proof.purpose === 'change_new') {
    if (proof.newEmail === null || !user.emailVerified) return 'invalid';
    await db
      .update(users)
      .set({
        email: proof.newEmail,
        emailVerified: true,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(users.id, userId));
    await recordIdentitySecurityFact(client, userId, 'email.change_verified');
    outcome = proof.purpose;
  } else return 'invalid';
  await db
    .update(authEmailProofs)
    .set({ consumedAt: sql`clock_timestamp()` })
    .where(eq(authEmailProofs.id, proof.id));
  return outcome;
}
