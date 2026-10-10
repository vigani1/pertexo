import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  insertAuthenticationMail,
  type AuthenticationMailInput,
} from './authentication-mail.js';
import { recordIdentitySecurityFact } from './security-facts.js';
type ProofPurpose = 'initial_verification' | 'change_old' | 'change_new';
type ProofUser = Readonly<{ id: string; email: string; name: string }>;
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
    return this.transaction(async (client) => {
      const current = await client.query<{
        status: string;
        email: string;
        email_verified: boolean;
      }>(
        'select status, email, email_verified from app.users where id=$1 for update',
        [user.id],
      );
      const row = current.rows[0];
      if (
        row?.status !== 'active' ||
        row.email.toLowerCase() !== user.email.toLowerCase() ||
        row.email_verified !== (purpose === 'change_old')
      )
        return false;
      await client.query(
        `insert into app.auth_email_proofs
           (id, token_digest, user_id, purpose, email, new_email, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          randomUUID(),
          tokenDigest,
          user.id,
          purpose,
          user.email,
          newEmail ?? null,
          expiresAt,
        ],
      );
      if (prepared !== undefined)
        await insertAuthenticationMail(client, prepared);
      return true;
    });
  }
  public async inspect(tokenDigest: Buffer) {
    const inspected = await this.pool.query<{
      purpose: ProofPurpose;
      new_email: string | null;
      display_name: string;
    }>(
      `select proof.purpose, proof.new_email, users.display_name
       from app.auth_email_proofs proof
       join app.users users on users.id = proof.user_id
       where proof.token_digest = $1 and proof.consumed_at is null
         and proof.expires_at > clock_timestamp() and users.status = 'active'
         and lower(users.email) = lower(proof.email)`,
      [tokenDigest],
    );
    return inspected.rows[0];
  }
  public async consume(
    tokenDigest: Buffer,
    next: Readonly<{ digest: Buffer; expiresAt: Date }> | undefined,
    nextMail: AuthenticationMailInput | undefined,
  ): Promise<ProofPurpose | 'invalid'> {
    return this.transaction((client) =>
      consumeProof(client, tokenDigest, next, nextMail),
    );
  }
  private async transaction<T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
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
}
/**
 * Consumes a live proof for the user's current address, with the user locked:
 * a first verification verifies the address and signs the user out, the old
 * address's confirmation issues the new address's proof, and the new
 * address's proof changes the address.
 */
async function consumeProof(
  client: PoolClient,
  tokenDigest: Buffer,
  next: Readonly<{ digest: Buffer; expiresAt: Date }> | undefined,
  nextMail: AuthenticationMailInput | undefined,
): Promise<ProofPurpose | 'invalid'> {
  const owner = await client.query<{ user_id: string }>(
    'select user_id from app.auth_email_proofs where token_digest=$1',
    [tokenDigest],
  );
  const userId = owner.rows[0]?.user_id;
  if (userId === undefined) return 'invalid';
  const users = await client.query<{
    status: string;
    email: string;
    email_verified: boolean;
  }>(
    'select status, email, email_verified from app.users where id=$1 for update',
    [userId],
  );
  const user = users.rows[0];
  if (user?.status !== 'active') return 'invalid';
  const proofs = await client.query<{
    id: string;
    purpose: string;
    email: string;
    new_email: string | null;
    user_id: string;
    usable: boolean;
  }>(
    `select id, purpose, email, new_email, user_id,
            consumed_at is null and expires_at > clock_timestamp() usable
     from app.auth_email_proofs where token_digest=$1 for update`,
    [tokenDigest],
  );
  const proof = proofs.rows[0];
  if (
    proof?.usable !== true ||
    proof.user_id !== userId ||
    proof.email.toLowerCase() !== user.email.toLowerCase()
  )
    return 'invalid';
  if (proof.purpose === 'initial_verification') {
    if (user.email_verified) return 'invalid';
    await client.query(
      'update app.users set email_verified=true, updated_at=clock_timestamp() where id=$1',
      [userId],
    );
    await client.query('delete from app.auth_sessions where user_id=$1', [
      userId,
    ]);
    await recordIdentitySecurityFact(client, userId, 'email.initial_verified');
  } else if (proof.purpose === 'change_old') {
    if (!user.email_verified || next === undefined || proof.new_email === null)
      return 'invalid';
    await client.query(
      `insert into app.auth_email_proofs
         (id, token_digest, user_id, purpose, email, new_email, expires_at)
       values ($1, $2, $3, 'change_new', $4, $5, $6)`,
      [
        randomUUID(),
        next.digest,
        userId,
        proof.email,
        proof.new_email,
        next.expiresAt,
      ],
    );
    if (nextMail !== undefined)
      await insertAuthenticationMail(client, nextMail);
    await recordIdentitySecurityFact(client, userId, 'email.old_confirmed');
  } else if (proof.purpose === 'change_new') {
    if (proof.new_email === null || !user.email_verified) return 'invalid';
    await client.query(
      `update app.users set email=$2, email_verified=true,
         updated_at=clock_timestamp() where id=$1`,
      [userId, proof.new_email],
    );
    await recordIdentitySecurityFact(client, userId, 'email.change_verified');
  } else return 'invalid';
  await client.query(
    'update app.auth_email_proofs set consumed_at=clock_timestamp() where id=$1',
    [proof.id],
  );
  return proof.purpose;
}
