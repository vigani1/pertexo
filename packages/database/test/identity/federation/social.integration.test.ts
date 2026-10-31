import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SocialSignInCommands } from '../../../src/tenant-access/index.js';
import { useIdentityCommandDatabase } from '../command.support.js';

const db = useIdentityCommandDatabase('social_proof');
const digest = () => createHash('sha256').update(randomUUID()).digest();

async function setup() {
  const user = await db.user('Social member');
  await db.asAdmin('update app.users set email_verified=true where id=$1', [
    user.id,
  ]);
  const commands = new SocialSignInCommands({
    pool: db.authenticationPool(),
    signUpMode: 'open',
    sessionTtlSeconds: 3600,
  });
  const attempt = {
    id: randomUUID(),
    provider: 'social-test',
    stateDigest: digest(),
    browserDigest: digest(),
    returnPath: '/workspaces?view=mine',
  };
  await commands.start(attempt);
  const proof = {
    attemptId: attempt.id,
    provider: attempt.provider,
    stateDigest: attempt.stateDigest,
    browserDigest: attempt.browserDigest,
    identity: {
      accountId: randomUUID(),
      email: user.email.toUpperCase(),
      emailVerified: true,
      displayName: 'Provider name',
    },
  };
  return { user, commands, attempt, proof };
}

describe('durable social sign-in proof', () => {
  it('binds lookup and consumption to the browser and rejects expired attempts', async () => {
    const { commands, attempt, proof } = await setup();
    expect(await commands.find(attempt.stateDigest, digest())).toBeUndefined();
    expect(
      await commands.complete({ ...proof, browserDigest: digest() }),
    ).toEqual({ kind: 'failed' });
    expect(
      await commands.find(attempt.stateDigest, attempt.browserDigest),
    ).toEqual({
      id: attempt.id,
      provider: attempt.provider,
      returnPath: attempt.returnPath,
    });
    await db.asAdmin(
      "update app.auth_sign_in_attempts set created_at=clock_timestamp()-interval '6 minutes', expires_at=clock_timestamp()-interval '1 second' where id=$1",
      [attempt.id],
    );
    expect(
      await commands.find(attempt.stateDigest, attempt.browserDigest),
    ).toBeUndefined();
    expect(await commands.complete(proof)).toEqual({ kind: 'failed' });
  });

  it('consumes the proof once and retains the return path and account binding', async () => {
    const { user, commands, attempt, proof } = await setup();
    await db.sessions(user.id);
    const result = await commands.complete(proof);
    expect(result.kind).toBe('signed_in');
    if (result.kind !== 'signed_in')
      throw new Error('Missing signed-in result');
    expect(result.returnPath).toBe(attempt.returnPath);
    expect(
      await commands.find(attempt.stateDigest, attempt.browserDigest),
    ).toBeUndefined();
    expect(await commands.complete(proof)).toEqual({ kind: 'failed' });
    expect(await db.liveSessions(user.id)).toBe(1);
    expect(
      await db.asAdmin(
        'select user_id,provider_id,account_id from app.auth_accounts where provider_id=$1 and account_id=$2',
        [proof.provider, proof.identity.accountId],
      ),
    ).toEqual([
      {
        user_id: user.id,
        provider_id: proof.provider,
        account_id: proof.identity.accountId,
      },
    ]);
    expect(
      await db.asAdmin(
        "select authentication_method,expires_at>clock_timestamp()+interval '59 minutes' ttl from app.auth_sessions where token=$1",
        [result.token],
      ),
    ).toEqual([{ authentication_method: 'social', ttl: true }]);
  });
});

describe('social sign-in email matching', () => {
  // db-runs-10: one email rule (trim, then NFKC, then lowercase) for every match.
  it('matches the provider address to the account after trim, NFKC and lowercase', async () => {
    const { user, commands, proof } = await setup();
    const result = await commands.complete({
      ...proof,
      identity: {
        ...proof.identity,
        email: ` ${fullWidth(user.email.toUpperCase())} `,
      },
    });

    expect(result.kind).toBe('signed_in');
    expect(
      await db.asAdmin(
        'select user_id from app.auth_accounts where provider_id=$1 and account_id=$2',
        [proof.provider, proof.identity.accountId],
      ),
    ).toEqual([{ user_id: user.id }]);
  });

  // db-runs-10: stored identities keep matching after the shared rule lands.
  it('keeps an account stored before the shared rule reachable by its canonical address', async () => {
    const { user, commands, proof } = await setup();
    await db.asAdmin('update app.users set email=$2 where id=$1', [
      user.id,
      fullWidth(user.email),
    ]);
    const result = await commands.complete({
      ...proof,
      identity: { ...proof.identity, email: user.email },
    });

    expect(result.kind).toBe('signed_in');
    expect(
      await db.asAdmin(
        'select user_id from app.auth_accounts where provider_id=$1 and account_id=$2',
        [proof.provider, proof.identity.accountId],
      ),
    ).toEqual([{ user_id: user.id }]);
  });
});

/** The same address in full-width forms, which NFKC folds back to ASCII. */
function fullWidth(value: string): string {
  return value.replace(/[!-~]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 0xfee0),
  );
}
