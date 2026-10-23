import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { expect, it } from 'vitest';

import {
  adminUrl,
  databaseUrl,
  mailedMessages,
  authRequest,
  followMailLink,
} from './fixture.js';

export function registerConsumesInitialVerificationOnceUnderConcurrent(): void {
  it('consumes initial verification once under concurrent clicks and rejects expiry', async () => {
    const concurrentEmail = `concurrent-proof-${randomUUID()}@example.test`;
    expect(
      (
        await authRequest('/v1/auth/sign-up/email', {
          name: 'Concurrent Proof',
          email: concurrentEmail,
          password: 'correct horse battery staple',
        })
      ).status,
    ).toBe(200);
    const link = mailedMessages(concurrentEmail).find(
      (message) => message.purpose === 'verification',
    )?.url;
    expect(link).toBeDefined();
    const results = await Promise.all([
      followMailLink(link ?? 'http://invalid', ''),
      followMailLink(link ?? 'http://invalid', ''),
    ]);
    expect(
      results.map((response) => response.headers.get('location')).sort(),
    ).toEqual([
      'http://pertexo.test/login?error=verification_invalid',
      'http://pertexo.test/login?verified=true',
    ]);
    const owner = new Pool({ connectionString: databaseUrl(adminUrl), max: 1 });
    try {
      const audited = await owner.query<{ count: number }>(
        `select count(*)::integer count from app.identity_security_audit_facts facts
           join app.users users on users.id=facts.user_id
          where users.email=$1 and facts.event_type='email.initial_verified'`,
        [concurrentEmail],
      );
      expect(audited.rows).toEqual([{ count: 1 }]);
      const expiredEmail = `expired-proof-${randomUUID()}@example.test`;
      expect(
        (
          await authRequest('/v1/auth/sign-up/email', {
            name: 'Expired Proof',
            email: expiredEmail,
            password: 'correct horse battery staple',
          })
        ).status,
      ).toBe(200);
      const expiredLink = mailedMessages(expiredEmail).find(
        (message) => message.purpose === 'verification',
      )?.url;
      expect(expiredLink).toBeDefined();
      await owner.query(
        `update app.auth_email_proofs
            set created_at=clock_timestamp()-interval '2 hours',
                expires_at=clock_timestamp()-interval '1 hour'
          where user_id=(select id from app.users where email=$1)`,
        [expiredEmail],
      );
      const rejected = await followMailLink(
        expiredLink ?? 'http://invalid',
        '',
      );
      expect(rejected.headers.get('location')).toContain(
        'error=verification_invalid',
      );
      const unchanged = await owner.query<{ email_verified: boolean }>(
        'select email_verified from app.users where email=$1',
        [expiredEmail],
      );
      expect(unchanged.rows).toEqual([{ email_verified: false }]);
    } finally {
      await owner.end();
    }
  });

  it('rolls back proof consumption, email verification and audit when revocation fails', async () => {
    const email = `rollback-proof-${randomUUID()}@example.test`;
    expect(
      (
        await authRequest('/v1/auth/sign-up/email', {
          name: 'Rollback Proof',
          email,
          password: 'correct horse battery staple',
        })
      ).status,
    ).toBe(200);
    const link = mailedMessages(email).find(
      (message) => message.purpose === 'verification',
    )?.url;
    expect(link).toBeDefined();
    const owner = new Pool({ connectionString: databaseUrl(adminUrl), max: 1 });
    try {
      await owner.query(`create function app.test_reject_proof_revocation()
        returns trigger language plpgsql as $$
        begin raise exception 'test proof revocation failure'; end; $$`);
      await owner.query(`create trigger test_reject_proof_revocation
        before delete on app.auth_sessions for each statement
        execute function app.test_reject_proof_revocation()`);
      await expect(
        followMailLink(link ?? 'http://invalid', ''),
      ).rejects.toThrow('test proof revocation failure');
      const unchanged = await owner.query<{
        verified: boolean;
        consumed: boolean;
        audited: number;
      }>(
        `select users.email_verified verified,
               proof.consumed_at is not null consumed,
               (select count(*)::integer from app.identity_security_audit_facts audit
                 where audit.user_id=users.id) audited
            from app.users users join app.auth_email_proofs proof
              on proof.user_id=users.id where users.email=$1`,
        [email],
      );
      expect(unchanged.rows).toEqual([
        { verified: false, consumed: false, audited: 0 },
      ]);
    } finally {
      await owner.query(
        'drop trigger if exists test_reject_proof_revocation on app.auth_sessions',
      );
      await owner.query(
        'drop function if exists app.test_reject_proof_revocation()',
      );
      await owner.end();
    }
    const retry = await followMailLink(link ?? 'http://invalid', '');
    expect(retry.headers.get('location')).toContain('verified=true');
  });
}
