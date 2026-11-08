import { userProfileResponseSchema } from '@pertexo/contracts';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createConnectionEnvelopeEncryption } from '@pertexo/secrets/server';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';
import { createTokenWorkspace } from '../api-tokens/api/portability/setup.js';

const encryption = {
  current: {
    version: 'sysmail-v1',
    key: Buffer.alloc(32, 8).toString('base64'),
  },
  previous: [],
};
for (const available of [true, false]) {
  describe.runIf(betterAuthIntegrationEnabled)(
    `server mail available=${String(available)}`,
    () => {
      const api = useBetterAuthRealApi(
        available ? 'sysmail_on' : 'sysmail_off',
        {
          automationTokens: true,
          ...(available
            ? {
                notificationMail: {
                  fromEmail: 'server@example.test',
                  encryption,
                },
              }
            : {}),
          connections: {
            config: { mode: 'self-managed', encryption },
            services: () => ({
              encryption: createConnectionEnvelopeEncryption({
                mode: 'self-managed',
                encryption,
              }),
            }),
          },
        },
      );
      it('reports availability and accepts only current member IDs', async () => {
        const w = await createTokenWorkspace({
          api,
          listen: () => api.listen(),
        });
        const memberId = userProfileResponseSchema.parse(
          (
            await api.send('GET', '/v1/users/me', { browser: w.browser })
          ).json(),
        ).id;
        const path = `${w.base}/failure-notification-destinations`;
        const list = await api.send('GET', path, { browser: w.browser });
        expect(list.statusCode).toBe(200);
        expect(list.json()).toMatchObject({
          systemMail: available
            ? { available: true }
            : {
                available: false,
                reason: 'This server has no system mail configured.',
              },
        });
        const post = (payload: object) =>
          api.send('POST', path, {
            browser: w.browser,
            headers: { 'idempotency-key': randomUUID() },
            payload,
          });
        const address = await post({
          kind: 'system_mail',
          toEmail: 'outsider@example.test',
        });
        expect(address.statusCode).toBe(400);
        const created = await post({ kind: 'system_mail', memberId: memberId });
        expect(created.statusCode).toBe(available ? 201 : 400);
        if (available) {
          expect(created.json()).toMatchObject({
            config: { kind: 'system_mail', memberId: memberId },
          });
          const outside = await post({
            kind: 'system_mail',
            memberId: randomUUID(),
          });
          expect(outside.statusCode).toBe(400);
          expect(outside.json()).toMatchObject({
            errors: [
              {
                path: '/memberId',
                message: 'Choose a current workspace member.',
              },
            ],
          });
        } else
          expect(created.json()).toMatchObject({
            errors: [
              {
                path: '/kind',
                message: 'This server has no system mail configured.',
              },
            ],
          });
      });
    },
  );
}
