import { authenticationMailAssociatedData } from '@pertexo/database/platform';

import { randomUUID } from 'node:crypto';
import { createSystemMailEnqueueStore } from '@pertexo/database/platform';

import { createApplicationSecretEnvelope } from '@pertexo/integrations/server';

import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { createBetterAuthRuntime } from '../../../../src/authentication/better-auth/runtime.js';

import { DurableAuthenticationMail } from '../../../../src/authentication/mail/delivery.js';

import { adminUrl, databaseUrl, apiUrl, cookieValue } from '../fixture.js';

export function registerCommitsOwnedProofSealedVerificationMail(): void {
  it('commits the owned proof and sealed verification mail together', async () => {
    const envelope = createApplicationSecretEnvelope({
      current: { version: 'v1', key: Buffer.alloc(32, 17).toString('base64') },
    });
    const store = createSystemMailEnqueueStore({
      connectionString: apiUrl,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 5_000,
      max: 1,
      ownerRole: 'pertexo_owner',
    });
    const durable = createBetterAuthRuntime({
      signUpMode: 'open',
      baseUrl: 'http://pertexo.test',
      secret: 'durable-proof-integration-secret-at-least-32-characters',
      database: {
        connectionString: apiUrl,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 5_000,
        max: 2,
      },
      secureCookies: false,
      sessionTtlSeconds: 3_600,
      trustedOrigins: ['http://pertexo.test'],
      mail: new DurableAuthenticationMail(
        store,
        envelope,
        'security@example.test',
      ),
    });
    const owner = new Pool({ connectionString: databaseUrl(adminUrl), max: 1 });
    const email = `durable-proof-${randomUUID()}@example.test`;
    try {
      const signup = await durable.auth.handler(
        new Request('http://pertexo.test/v1/auth/sign-up/email', {
          method: 'POST',
          headers: {
            origin: 'http://pertexo.test',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            name: 'Durable Proof',
            email,
            password: 'correct horse battery staple',
          }),
        }),
      );
      expect(signup.status).toBe(200);
      const stored = await owner.query<{
        id: string;
        expires_at: Date;
        payload_ciphertext: string;
        payload_nonce: string;
        payload_tag: string;
        payload_key_version: string;
      }>(`select mail.id,mail.expires_at,mail.payload_ciphertext,
               mail.payload_nonce,mail.payload_tag,mail.payload_key_version
            from app.system_mail_deliveries mail
           where mail.purpose='verification'
           order by mail.created_at desc limit 1`);
      const row = stored.rows[0];
      expect(row).toBeDefined();
      expect(row?.payload_ciphertext).not.toContain(email);
      const payload = JSON.parse(
        envelope.open(
          {
            ciphertext: row?.payload_ciphertext ?? '',
            nonce: row?.payload_nonce ?? '',
            tag: row?.payload_tag ?? '',
            keyVersion: row?.payload_key_version ?? '',
          },
          authenticationMailAssociatedData(
            'verification',
            row?.id ?? '',
            row?.expires_at ?? new Date(),
          ),
        ),
      ) as {
        toEmail: string;
        text: string;
      };
      expect(payload.toEmail).toBe(email);
      const link = payload.text
        .split('\n')
        .find((line) =>
          line.startsWith('http://pertexo.test/v1/auth/verify-email?'),
        );
      expect(link).toBeDefined();
      const verified = await durable.auth.handler(
        new Request(link ?? 'http://invalid'),
      );
      expect(verified.headers.get('location')).toContain('verified=true');
      const replay = await durable.auth.handler(
        new Request(link ?? 'http://invalid'),
      );
      expect(replay.headers.get('location')).toContain(
        'error=verification_invalid',
      );
      const signedIn = await durable.auth.handler(
        new Request('http://pertexo.test/v1/auth/sign-in/email', {
          method: 'POST',
          headers: {
            origin: 'http://pertexo.test',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            email,
            password: 'correct horse battery staple',
          }),
        }),
      );
      expect(signedIn.status).toBe(200);
      const session = cookieValue(signedIn.headers.getSetCookie());
      expect(session).toBeDefined();
      const csrf = 'd'.repeat(32);
      const newEmail = `changed-${email}`;
      const started = await durable.auth.handler(
        new Request('http://pertexo.test/v1/auth/change-email', {
          method: 'POST',
          headers: {
            origin: 'http://pertexo.test',
            'content-type': 'application/json',
            cookie: `pertexo_session=${session ?? ''}; pertexo_csrf=${csrf}`,
            'x-csrf-token': csrf,
          },
          body: JSON.stringify({ newEmail }),
        }),
      );
      expect(started.status).toBe(200);
      const readNewestMailLink = async (purpose: string): Promise<string> => {
        const latest = await owner.query<NonNullable<typeof row>>(
          `select id,expires_at,payload_ciphertext,payload_nonce,
                  payload_tag,payload_key_version
             from app.system_mail_deliveries
            where purpose=$1 order by created_at desc limit 1`,
          [purpose],
        );
        const message = latest.rows[0];
        expect(message).toBeDefined();
        const decoded = JSON.parse(
          envelope.open(
            {
              ciphertext: message?.payload_ciphertext ?? '',
              nonce: message?.payload_nonce ?? '',
              tag: message?.payload_tag ?? '',
              keyVersion: message?.payload_key_version ?? '',
            },
            authenticationMailAssociatedData(
              purpose,
              message?.id ?? '',
              message?.expires_at ?? new Date(),
            ),
          ),
        ) as { text: string };
        const found = decoded.text
          .split('\n')
          .find((line) =>
            line.startsWith('http://pertexo.test/v1/auth/verify-email?'),
          );
        expect(found).toBeDefined();
        return found ?? 'http://invalid';
      };
      const oldLink = await readNewestMailLink('email_change_confirmation');
      expect(
        (await durable.auth.handler(new Request(oldLink))).headers.get(
          'location',
        ),
      ).toContain('emailChangePending=true');
      const newLink = await readNewestMailLink('verification');
      expect(
        (await durable.auth.handler(new Request(newLink))).headers.get(
          'location',
        ),
      ).toContain('emailChanged=true');
      const changed = await owner.query<{ email_verified: boolean }>(
        'select email_verified from app.users where email=$1',
        [newEmail],
      );
      expect(changed.rows).toEqual([{ email_verified: true }]);
      await owner.query(`create function app.test_reject_proof_mail()
        returns trigger language plpgsql as $$
        begin raise exception 'test proof mail failure'; end; $$`);
      await owner.query(`create trigger test_reject_proof_mail
        before insert on app.system_mail_deliveries for each row
        execute function app.test_reject_proof_mail()`);
      const failedEmail = `failed-durable-proof-${randomUUID()}@example.test`;
      try {
        await expect(
          durable.auth.handler(
            new Request('http://pertexo.test/v1/auth/sign-up/email', {
              method: 'POST',
              headers: {
                origin: 'http://pertexo.test',
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                name: 'Undelivered Proof',
                email: failedEmail,
                password: 'correct horse battery staple',
              }),
            }),
          ),
        ).rejects.toThrow('test proof mail failure');
        const failedProofs = await owner.query<{ count: number }>(
          `select count(*)::integer count from app.auth_email_proofs proof
             join app.users users on users.id=proof.user_id
            where users.email=$1`,
          [failedEmail],
        );
        expect(failedProofs.rows).toEqual([{ count: 0 }]);
      } finally {
        await owner.query(
          'drop trigger if exists test_reject_proof_mail on app.system_mail_deliveries',
        );
        await owner.query(
          'drop function if exists app.test_reject_proof_mail()',
        );
      }
    } finally {
      await Promise.all([durable.close(), store.close(), owner.end()]);
    }
  });
}
