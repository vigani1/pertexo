import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createApplicationSecretEnvelope,
  authenticationMailAssociatedData,
} from '@pertexo/secrets/server';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'reset proof and durable mail issuance',
  () => {
    const envelope = createApplicationSecretEnvelope({
      current: { version: 'v1', key: Buffer.alloc(32, 3).toString('base64') },
    });
    const api = useBetterAuthRealApi('reset_atomic', {
      authenticationMail: (local) => ({
        sendVerification: (input) => local.sendVerification(input),
        sendEmailChangeConfirmation: (input) =>
          local.sendEmailChangeConfirmation(input),
        sendSecurityNotice: (input) => local.sendSecurityNotice(input),
        sendPasswordReset: (input) => local.sendPasswordReset(input),
        preparePasswordReset: (input) => {
          const id = randomUUID();
          return {
            id,
            purpose: 'password_reset',
            expiresAt: input.expiresAt,
            sealedPayload: envelope.seal(
              JSON.stringify({
                fromEmail: 'from@example.test',
                toEmail: input.recipient,
                subject: 'Reset',
                text: input.url,
              }),
              authenticationMailAssociatedData(
                'password_reset',
                id,
                input.expiresAt,
              ),
            ),
          };
        },
      }),
    });

    it('commits a reset proof and encrypted mail together, or neither when durable mail cannot be saved', async () => {
      const email = `${randomUUID()}@example.test`;
      await api.signUp(email, '/login?verified=true');
      const reset = () =>
        api.send('POST', '/v1/auth/request-password-reset', {
          payload: { email, redirectTo: '/reset-password' },
        });
      const counts = async () =>
        (
          await api.database().query<{ proofs: number; mail: number }>(`select
      (select count(*)::int from app.auth_verifications where identifier like 'reset-password:%') proofs,
      (select count(*)::int from app.system_mail_deliveries where purpose='password_reset') mail`)
        ).rows[0];
      await api.database()
        .query(`create function public.reject_reset_mail() returns trigger language plpgsql as $$ begin raise exception 'Mail storage unavailable'; end $$;
      create trigger reject_reset_mail before insert on app.system_mail_deliveries for each row execute function public.reject_reset_mail()`);
      try {
        const failed = await reset();
        expect(failed.statusCode).toBe(500);
        expect(await counts()).toEqual({ proofs: 0, mail: 0 });
        expect(
          api
            .mailedMessages(email)
            .filter((message) => message.purpose === 'password_reset'),
        ).toEqual([]);
      } finally {
        await api
          .database()
          .query(
            'drop trigger reject_reset_mail on app.system_mail_deliveries; drop function public.reject_reset_mail()',
          );
      }
      expect((await reset()).statusCode).toBe(200);
      expect(await counts()).toEqual({ proofs: 1, mail: 1 });
      expect(
        (
          await api
            .database()
            .query<{ payload_ciphertext: string }>(
              "select payload_ciphertext from app.system_mail_deliveries where purpose='password_reset'",
            )
        ).rows[0]?.payload_ciphertext,
      ).not.toContain(email);
    });
  },
);
