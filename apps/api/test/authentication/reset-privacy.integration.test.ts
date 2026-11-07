import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';
import { silent } from '../support/better-auth/api/environment.js';

describe.runIf(betterAuthIntegrationEnabled)(
  'reset request privacy across account states and faults',
  () => {
    let deliveryFails = false;
    const diagnostics: unknown[] = [];
    const api = useBetterAuthRealApi('reset_privacy', {
      logger: {
        ...silent,
        error: (event, fields) => {
          diagnostics.push({ event, ...fields });
        },
      },
      authenticationMail: (local) => ({
        sendVerification: (input) => local.sendVerification(input),
        sendEmailChangeConfirmation: (input) =>
          local.sendEmailChangeConfirmation(input),
        sendSecurityNotice: (input) => local.sendSecurityNotice(input),
        sendPasswordReset: (input) =>
          deliveryFails
            ? Promise.reject(new Error(`private-delivery-failure:${input.url}`))
            : local.sendPasswordReset(input),
      }),
    });
    it.each(['proof', 'delivery'] as const)(
      'accepts all account states identically under the same %s fault',
      async (fault) => {
        const addresses = new Map<string, string>();
        for (const kind of [
          'present',
          'unverified',
          'social-only',
          'inactive',
        ]) {
          const email = `${kind}-${randomUUID()}@example.test`;
          await api.signUp(email, '/workspaces');
          addresses.set(kind, email);
        }
        addresses.set('absent', `absent-${randomUUID()}@example.test`);
        await api
          .database()
          .query('update app.users set email_verified=false where email=$1', [
            addresses.get('unverified'),
          ]);
        await api
          .database()
          .query(
            "delete from app.auth_accounts where user_id=(select id from app.users where email=$1) and provider_id='credential'",
            [addresses.get('social-only')],
          );
        await api
          .database()
          .query(
            "insert into app.auth_accounts(id,user_id,provider_id,account_id) select $1,id,'google',$2 from app.users where email=$2",
            [randomUUID(), addresses.get('social-only')],
          );
        await api
          .database()
          .query("update app.users set status='suspended' where email=$1", [
            addresses.get('inactive'),
          ]);
        if (fault === 'proof')
          await api
            .database()
            .query(
              "create function public.reject_privacy_proof() returns trigger language plpgsql as $$ begin raise exception 'private-proof-failure: %', new.identifier; end $$; create trigger reject_privacy_proof before insert on app.auth_verifications for each row execute function public.reject_privacy_proof()",
            );
        deliveryFails = fault === 'delivery';
        diagnostics.length = 0;
        try {
          const requestIds = new Map<string, unknown>();
          for (const [kind, email] of addresses) {
            const response = await api.send(
              'POST',
              '/v1/auth/request-password-reset',
              {
                headers: { 'x-request-id': `reset-${fault}-${kind}` },
                payload: { email },
              },
            );
            requestIds.set(kind, response.headers['x-request-id']);
            expect(response.statusCode, response.payload).toBe(200);
            expect(response.json()).toEqual({
              status: true,
              message:
                'If this email exists in our system, check your email for the reset link',
            });
            expect(
              api
                .mailedMessages(email)
                .filter((message) => message.purpose === 'password_reset'),
            ).toEqual([]);
          }
          expect(diagnostics).toEqual(
            ['present', 'unverified'].map((kind) => ({
              event: 'authentication.failed',
              requestId: requestIds.get(kind),
              flow: 'password_reset',
              reason: 'internal_failure',
            })),
          );
          expect(JSON.stringify(diagnostics)).not.toContain('private-');
          for (const email of addresses.values())
            expect(JSON.stringify(diagnostics)).not.toContain(email);
          if (fault === 'proof')
            expect(
              (
                await api
                  .database()
                  .query(
                    "select id from app.auth_verifications where identifier like 'reset-password:%'",
                  )
              ).rows,
            ).toEqual([]);
        } finally {
          deliveryFails = false;
          if (fault === 'proof')
            await api
              .database()
              .query(
                'drop trigger reject_privacy_proof on app.auth_verifications; drop function public.reject_privacy_proof()',
              );
          await api
            .database()
            .query(
              "delete from app.auth_verifications where identifier like 'reset-password:%'",
            );
        }
      },
    );
    it('keeps local present and absent request work in a comparable timing range', async () => {
      const present = `${randomUUID()}@example.test`,
        absent = `${randomUUID()}@example.test`;
      await api.signUp(present, '/workspaces');
      await api
        .database()
        .query(
          'create function public.delay_reset_write() returns trigger language plpgsql as $$ begin perform pg_sleep(0.02); return new; end $$; create trigger delay_reset_write before insert on app.auth_verifications for each row execute function public.delay_reset_write()',
        );
      try {
        const times = new Map<string, number[]>([
          [present, []],
          [absent, []],
        ]);
        for (let index = 0; index < 7; index += 1) {
          for (const email of index % 2 === 0
            ? [present, absent]
            : [absent, present]) {
            const start = performance.now();
            expect(
              (
                await api.send('POST', '/v1/auth/request-password-reset', {
                  payload: { email },
                })
              ).statusCode,
            ).toBe(200);
            times.get(email)?.push(performance.now() - start);
          }
        }
        const median = (email: string) => {
          const values = times.get(email) ?? [];
          values.sort((a, b) => a - b);
          return values[3] ?? 0;
        };
        expect(median(present)).toBeLessThan(median(absent) * 3);
        expect(median(absent)).toBeLessThan(median(present) * 3);
        expect(api.mailedMessages(absent)).toEqual([]);
        expect(
          api
            .mailedMessages(present)
            .filter((message) => message.purpose === 'password_reset'),
        ).toHaveLength(7);
      } finally {
        await api
          .database()
          .query(
            'drop trigger delay_reset_write on app.auth_verifications; drop function public.delay_reset_write()',
          );
      }
    });
  },
);
