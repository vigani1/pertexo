import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { issueBrowserSession } from '../../support/browser-session.fixture.js';
import { application, identityRuntime, seedWebhook } from '../fixture.js';
import { endpointOf, inWorkspace } from './support.js';

export function registerRefusedBodies(): void {
  it.each([
    ['provision', 'naming a mode', { authentication: { mode: 'secret_url' } }],
    ['provision', 'naming nothing we know', { anything: true }],
    [
      'rotate-endpoint',
      'naming a mode',
      { authentication: { mode: 'secret_url' } },
    ],
    ['rotate-endpoint', 'naming nothing we know', { anything: true }],
  ] as const)(
    '%s refuses a body %s and changes nothing, then works with none or {}',
    async (command, _name, payload) => {
      const seeded = await seedWebhook(`body-${randomUUID()}`);
      const session = await issueBrowserSession(
        identityRuntime.dependencies.sessions,
        seeded.actorId,
      );
      const url = `/v1/workspaces/${seeded.workspaceId}/workflows/${seeded.workflowId}/triggers/${seeded.trigger.id}/webhook/${command}`;
      const headers = (key: string) => ({
        cookie: session.cookieHeader,
        'x-csrf-token': session.csrf,
        'idempotency-key': key,
      });
      const endpoint = await endpointOf(seeded);
      const receipts = async () =>
        (
          await inWorkspace<{ count: number }>(
            seeded.workspaceId,
            `select count(*)::int count from app.idempotency_records
              where workspace_id=$1 and operation like 'webhook.trigger.%'`,
            [seeded.workspaceId],
          )
        ).rows[0]?.count;
      const receiptsBefore = await receipts();

      const refused = await application.inject({
        method: 'POST',
        url,
        headers: headers(randomUUID()),
        payload,
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({ code: 'request.invalid' });
      expect(await endpointOf(seeded)).toEqual(endpoint);
      expect(await receipts()).toBe(receiptsBefore);

      if (command === 'rotate-endpoint') {
        const withEmptyObject = await application.inject({
          method: 'POST',
          url,
          headers: headers(randomUUID()),
          payload: {},
        });
        expect(withEmptyObject.statusCode, withEmptyObject.body).toBe(200);
        const firstHash = (await endpointOf(seeded)).endpoint_key_hash;
        expect(firstHash).not.toBe(endpoint.endpoint_key_hash);
        const withNoBody = await application.inject({
          method: 'POST',
          url,
          headers: headers(randomUUID()),
        });
        expect(withNoBody.statusCode, withNoBody.body).toBe(200);
        expect((await endpointOf(seeded)).endpoint_key_hash).not.toBe(
          firstHash,
        );
        return;
      }
      // Provisioned already, so the same request is its receipt, with or without a body.
      for (const request of [{ payload: {} }, {}]) {
        const answered = await application.inject({
          method: 'POST',
          url,
          headers: headers(`direct-webhook-provision-${seeded.provisionLabel}`),
          ...request,
        });
        expect(answered.statusCode, answered.body).toBe(200);
      }
      expect(await endpointOf(seeded)).toEqual(endpoint);
    },
    60_000,
  );
}
