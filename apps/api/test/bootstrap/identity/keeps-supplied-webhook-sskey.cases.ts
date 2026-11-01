import { expect, it, vi } from 'vitest';

import type { ApiWebhookRuntime } from '../../../src/platform/webhooks/runtime.module.js';
import type { WebhookManagementService } from '../../../src/webhooks/management/service.js';

import { createBetterAuthFixtureApplication } from '../../support/better-auth/fixture-application.js';
import { FixtureResourceOwner } from '../../browser/harness/resource-owner.js';

import {
  config,
  dependencies,
  identityRuntime,
  applicationFixture,
} from '../fixture.js';

export function registerKeepsSuppliedWebhookSSKey(): void {
  it.each([
    ['provision', 'provision', undefined],
    ['provision', 'provision', 'first,second'],
    ['rotate-endpoint', 'rotateEndpoint', undefined],
    ['rotate-endpoint', 'rotateEndpoint', 'first,second'],
    ['rotate-secret', 'rotateSecret', undefined],
    ['rotate-secret', 'rotateSecret', 'first,second'],
  ] as const)(
    'keeps supplied webhook %s (%s key %s) behind actual fixture session, CSRF, key and tenant guards',
    async (operation, method, rejectedKey) => {
      const owner = new FixtureResourceOwner();
      const close = vi.fn().mockResolvedValue(undefined);
      const provision = vi.fn().mockResolvedValue({
        trigger: {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          workflowId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          workflowVersionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          nodeId: 'signed-input',
          kind: 'webhook',
          status: 'active',
          healthStatus: 'healthy',
          lastErrorCode: null,
          endpointReady: true,
          authentication: { mode: 'signed', allowedOrigins: [] },
          reconciledAt: null,
        },
        replayed: true,
      });
      const runtime = {
        service: {
          [method]: provision,
        } as unknown as WebhookManagementService,
        ingress: {
          database: { resolveVerification: vi.fn().mockResolvedValue(null) },
          encryption: {},
          checkpointFactory: () => ({
            checkpoint: {},
          }),
        },
        close,
      } as unknown as ApiWebhookRuntime;
      const csrf = 'c'.repeat(32);
      const cookie = `pertexo_session=${'s'.repeat(43)}; pertexo_csrf=${csrf}`;
      const path = `/v1/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/workflows/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/triggers/cccccccc-cccc-4ccc-8ccc-cccccccccccc/webhook/${operation}`;
      const payload =
        operation === 'rotate-secret' ? { endpointKey: 'a'.repeat(43) } : {};
      try {
        applicationFixture.application =
          await createBetterAuthFixtureApplication({
            config: config,
            dependencies: {
              ...dependencies(),
              identityRuntime: identityRuntime(undefined, true),
              webhookRuntime: runtime,
            },
            owner: owner,
          });
        const validHeaders = {
          cookie,
          'x-csrf-token': csrf,
          'idempotency-key': 'owned-provision',
        };
        for (const [url, headers, status] of [
          [path, {}, 401],
          [path, { cookie, 'idempotency-key': 'owned-provision' }, 403],
          [
            path.replace(
              'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
            ),
            validHeaders,
            404,
          ],
        ] as const) {
          const response = await applicationFixture.application.inject({
            method: 'POST',
            url,
            headers,
            payload,
          });
          expect(response.statusCode).toBe(status);
          expect(provision).not.toHaveBeenCalled();
        }
        const rejected = await applicationFixture.application.inject({
          method: 'POST',
          url: path,
          headers: {
            cookie,
            'x-csrf-token': csrf,
            ...(rejectedKey === undefined
              ? {}
              : { 'idempotency-key': rejectedKey }),
          },
          payload,
        });
        expect(rejected.statusCode).toBe(400);
        expect(rejected.json()).toMatchObject({
          code: 'request.invalid',
          status: 400,
        });
        expect(provision).not.toHaveBeenCalled();
        if (operation !== 'rotate-secret') {
          // api-design-18: a body naming settings used to be ignored, and a signed
          // endpoint came back for a caller who asked for a secret URL.
          const unaskedFor = await applicationFixture.application.inject({
            method: 'POST',
            url: path,
            headers: validHeaders,
            payload: { authentication: { mode: 'secret_url' } },
          });
          expect(unaskedFor.statusCode).toBe(400);
          expect(unaskedFor.json()).toMatchObject({ code: 'request.invalid' });
          expect(provision).not.toHaveBeenCalled();
        }
        const accepted = await applicationFixture.application.inject({
          method: 'POST',
          url: path,
          headers: validHeaders,
          payload,
        });
        expect(accepted.statusCode).toBe(200);
        expect(provision).toHaveBeenCalledOnce();
        expect(provision).toHaveBeenCalledWith(
          expect.objectContaining({
            actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            triggerId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            idempotencyKey: 'owned-provision',
          }),
        );
        provision.mockRejectedValueOnce(
          new Error('Unexpected service failure'),
        );
        const unexpected = await applicationFixture.application.inject({
          method: 'POST',
          url: path,
          headers: validHeaders,
          payload,
        });
        expect(unexpected.statusCode).toBe(500);
        expect(provision).toHaveBeenCalledTimes(2);
      } finally {
        await owner.close();
        applicationFixture.application = undefined;
      }
      expect(close).toHaveBeenCalledOnce();
    },
  );
}
