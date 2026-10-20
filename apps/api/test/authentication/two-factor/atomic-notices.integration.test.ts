import { randomUUID } from 'node:crypto';
import { APIError } from 'better-auth/api';
import { describe, expect, it } from 'vitest';
import { createApplicationSecretEnvelope } from '@pertexo/integrations/server';
import { DurableAuthenticationMail } from '../../../src/authentication/mail/delivery.js';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../../support/better-auth/real-api.support.js';
import {
  challengeCookie,
  enrollFactor,
  factorPassword,
} from '../../support/better-auth/two-factor.js';

describe.skipIf(!betterAuthIntegrationEnabled)(
  'atomic two-factor security notices',
  () => {
    let refusePreparation: 'prepare' | 'policy' | undefined;
    const durable = new DurableAuthenticationMail(
      {
        enqueue: () =>
          Promise.reject(new Error('Must enqueue in the security transaction')),
        close: () => Promise.resolve(),
      },
      createApplicationSecretEnvelope({
        current: {
          version: 'mail-v1',
          key: Buffer.alloc(32, 0x68).toString('base64'),
        },
        previous: [],
      }),
      'security@example.test',
    );
    for (const operation of ['recovery', 'disable'] as const) {
      describe(operation, () => {
        const api = useBetterAuthRealApi(`2fa_atomic_${operation}`, {
          databasePoolMax: 1,
          authenticationMail: (local) => ({
            sendVerification: (input) => local.sendVerification(input),
            sendPasswordReset: (input) => local.sendPasswordReset(input),
            sendEmailChangeConfirmation: (input) =>
              local.sendEmailChangeConfirmation(input),
            sendSecurityNotice: (input) => local.sendSecurityNotice(input),
            prepareSecurityNotice: (input) => {
              if (refusePreparation === 'prepare')
                throw new Error('Fixture sealing failure');
              if (refusePreparation === 'policy')
                throw new APIError('CONFLICT', {
                  code: 'AUTHENTICATION_CHANGED',
                  message: 'Fixture policy changed',
                });
              return durable.prepareSecurityNotice(input);
            },
          }),
        });

        it.each(['prepare', 'policy', 'audit', 'outbox'] as const)(
          `${operation}: rolls back on %s failure and retries without losing the notice`,
          async (failure) => {
            const email = `${randomUUID()}@example.test`;
            await api.signUp(email, '/workspaces');
            const factor = await enrollFactor(api, await api.signIn(email));
            const purpose =
              operation === 'recovery'
                ? 'recovery_code_sign_in'
                : 'two_factor_disabled';
            const event =
              operation === 'recovery'
                ? 'two_factor.recovery_code_used'
                : 'two_factor.disabled';
            const read = async () => {
              const result = await api.database().query<{
                two_factor_enabled: boolean;
                backup_codes: string | null;
                sessions: number;
                facts: number;
                mail: number;
              }>(
                `select users.two_factor_enabled, factor.backup_codes,
          (select count(*)::int from app.auth_sessions where user_id=users.id) sessions,
          (select count(*)::int from app.identity_security_audit_facts where user_id=users.id and event_type=$2) facts,
          (select count(*)::int from app.system_mail_deliveries where purpose=$3) mail
          from app.users users left join app.auth_two_factors factor on factor.user_id=users.id where users.email=$1`,
                [email, event, purpose],
              );
              const row = result.rows[0];
              if (row === undefined) throw new Error('Fixture user missing');
              return row;
            };
            const challenge =
              operation === 'recovery'
                ? challengeCookie(
                    await api.send('POST', '/v1/auth/sign-in/email', {
                      payload: { email, password: factorPassword },
                    }),
                  )
                : undefined;
            const before = await read();
            const table =
              failure === 'audit'
                ? 'identity_security_audit_facts'
                : 'system_mail_deliveries';
            if (failure === 'prepare' || failure === 'policy')
              refusePreparation = failure;
            else
              await api
                .database()
                .query(
                  `alter table app.${table} add constraint fixture_refuse_notice check (${failure === 'audit' ? `event_type <> '${event}'` : `purpose <> '${purpose}'`}) not valid`,
                );
            const command = () =>
              operation === 'recovery'
                ? api.send('POST', '/v1/auth/two-factor/verify-backup-code', {
                    headers: { cookie: challenge ?? '' },
                    payload: { code: factor.backupCodes[0] },
                  })
                : api.send('POST', '/v1/auth/two-factor/disable', {
                    browser: factor.browser,
                    payload: { password: factorPassword },
                  });
            try {
              const rejected = await command();
              expect(rejected.statusCode, rejected.payload).toBe(
                failure === 'policy' ? 409 : 500,
              );
              expect(rejected.headers['set-cookie']).toBeUndefined();
              expect(await read()).toEqual(before);
            } finally {
              refusePreparation = undefined;
              if (failure === 'audit' || failure === 'outbox')
                await api
                  .database()
                  .query(
                    `alter table app.${table} drop constraint fixture_refuse_notice`,
                  );
            }
            const accepted = await command();
            expect(accepted.statusCode, accepted.payload).toBe(200);
            const after = await read();
            expect(after).toMatchObject({ facts: 1, mail: before.mail + 1 });
            if (operation === 'disable')
              expect(after.two_factor_enabled).toBe(false);
            else expect(after.backup_codes).not.toBe(before.backup_codes);
          },
        );
      });
    }
  },
);
