import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

type PasswordChangeResult = 'changed' | 'invalid' | 'inactive';
type PasswordSetupResult = 'configured' | 'already' | 'unverified' | 'inactive';
type PasswordResetResult = 'reset' | 'invalid';
type MethodUnlinkResult = 'unlinked' | 'last_method' | 'not_found';

/** Credential changes and revocation share one database commit. */
export async function changePasswordAndRevokeSessions(
  pool: Pool,
  input: Readonly<{
    userId: string;
    currentPassword: string;
    newPasswordHash: string;
    verify: (hash: string, password: string) => Promise<boolean>;
  }>,
): Promise<PasswordChangeResult> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const user = await client.query<{ status: string }>(
      'select status from app.users where id=$1 for update',
      [input.userId],
    );
    if (user.rows[0]?.status !== 'active') {
      await client.query('rollback');
      return 'inactive';
    }
    const account = await client.query<{ id: string; password: string | null }>(
      `select id,password from app.auth_accounts
        where user_id=$1 and provider_id='credential'
        for update`,
      [input.userId],
    );
    const credential = account.rows[0];
    if (
      credential?.password === null ||
      credential?.password === undefined ||
      !(await input.verify(credential.password, input.currentPassword))
    ) {
      await client.query('rollback');
      return 'invalid';
    }
    await client.query(
      `update app.auth_accounts
          set password=$2,updated_at=clock_timestamp()
        where id=$1`,
      [credential.id, input.newPasswordHash],
    );
    await client.query('delete from app.auth_sessions where user_id=$1', [
      input.userId,
    ]);
    await client.query(
      `select app.record_identity_method_audit_fact($1,'password.changed')`,
      [input.userId],
    );
    await client.query('commit');
    return 'changed';
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function setupPasswordAndRevokeSessions(
  pool: Pool,
  input: Readonly<{ userId: string; passwordHash: string }>,
): Promise<PasswordSetupResult> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const user = await client.query<{
      status: string;
      email_verified: boolean;
    }>('select status,email_verified from app.users where id=$1 for update', [
      input.userId,
    ]);
    if (user.rows[0]?.status !== 'active') {
      await client.query('rollback');
      return 'inactive';
    }
    if (!user.rows[0].email_verified) {
      await client.query('rollback');
      return 'unverified';
    }
    const existing = await client.query(
      `select id from app.auth_accounts
        where user_id=$1 and provider_id='credential'
        for update`,
      [input.userId],
    );
    if (existing.rowCount !== 0) {
      await client.query('rollback');
      return 'already';
    }
    await client.query(
      `insert into app.auth_accounts(
         id,account_id,provider_id,user_id,password
       ) values ($1,$2::text,'credential',$2::uuid,$3)`,
      [randomUUID(), input.userId, input.passwordHash],
    );
    await client.query('delete from app.auth_sessions where user_id=$1', [
      input.userId,
    ]);
    await client.query(
      `select app.record_identity_method_audit_fact($1,'password.configured')`,
      [input.userId],
    );
    await client.query('commit');
    return 'configured';
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** A reset token cannot create a new credential method or survive a committed reset. */
export async function resetPasswordAndRevokeSessions(
  pool: Pool,
  input: Readonly<{ token: string; passwordHash: string }>,
): Promise<PasswordResetResult> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const verification = await client.query<{
      id: string;
      value: string;
      expires_at: Date;
    }>(
      `select id,value,expires_at from app.auth_verifications
        where identifier=$1
        order by created_at desc,id
        limit 1 for update`,
      [`reset-password:${input.token}`],
    );
    const proof = verification.rows[0];
    if (proof === undefined || proof.expires_at.getTime() <= Date.now()) {
      await client.query('rollback');
      return 'invalid';
    }
    const user = await client.query<{ status: string }>(
      'select status from app.users where id=$1::uuid for update',
      [proof.value],
    );
    if (user.rows[0]?.status !== 'active') {
      await client.query('rollback');
      return 'invalid';
    }
    const account = await client.query<{ id: string }>(
      `select id from app.auth_accounts
        where user_id=$1::uuid and provider_id='credential'
        for update`,
      [proof.value],
    );
    const credential = account.rows[0];
    if (credential === undefined) {
      await client.query('rollback');
      return 'invalid';
    }
    await client.query(
      `update app.auth_accounts
          set password=$2,updated_at=clock_timestamp()
        where id=$1`,
      [credential.id, input.passwordHash],
    );
    await client.query('delete from app.auth_sessions where user_id=$1::uuid', [
      proof.value,
    ]);
    await client.query('delete from app.auth_verifications where id=$1', [
      proof.id,
    ]);
    await client.query(
      `select app.record_identity_method_audit_fact($1,'password.reset')`,
      [proof.value],
    );
    await client.query('commit');
    return 'reset';
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** The last sign-in method cannot be removed; removal revokes every session. */
export async function unlinkMethodAndRevokeSessions(
  pool: Pool,
  input: Readonly<{ userId: string; methodId: string }>,
): Promise<MethodUnlinkResult> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select id from app.users where id=$1 for update', [
      input.userId,
    ]);
    const accounts = await client.query<{ id: string }>(
      `select id from app.auth_accounts
        where user_id=$1
        order by id
        for update`,
      [input.userId],
    );
    if (accounts.rows.length <= 1) {
      await client.query('rollback');
      return 'last_method';
    }
    const removed = await client.query(
      `delete from app.auth_accounts
        where id=$1 and user_id=$2
        returning id`,
      [input.methodId, input.userId],
    );
    if (removed.rowCount !== 1) {
      await client.query('rollback');
      return 'not_found';
    }
    await client.query('delete from app.auth_sessions where user_id=$1', [
      input.userId,
    ]);
    await client.query(
      `select app.record_identity_method_audit_fact($1,'method.unlinked')`,
      [input.userId],
    );
    await client.query('commit');
    return 'unlinked';
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
