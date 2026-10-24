import { FakeIdentityModule } from '../support/identity-module.js';
import { WebhookPreflightController } from '../../src/webhooks/authentication/preflight.controller.js';
import type { WebhookIngressDependencies } from '../../src/webhooks/ingress/register.js';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { WebhookManagementController } from '../../src/webhooks/management/controllers.js';
import {
  WebhookReadGuard,
  WebhookUpdateGuard,
} from '../../src/webhooks/management/guards.js';
import { WebhookModule } from '../../src/webhooks/module.js';
import { WebhookManagementService } from '../../src/webhooks/management/service.js';
import { WEBHOOK_AUTHORIZATION } from '../../src/webhooks/tokens.js';

const webhookOperations = {
  list: vi.fn(),
  provision: vi.fn(),
  rotateEndpoint: vi.fn(),
  rotateSecret: vi.fn(),
};
const service = webhookOperations as unknown as WebhookManagementService;
const runtime = { service, ingress: {} as WebhookIngressDependencies };
const authorization = { findAccess: vi.fn().mockResolvedValue(undefined) };

describe('webhook Nest module', () => {
  it('registers one supplied service, authorization source, and guard pair', () => {
    const dynamic = WebhookModule.register(runtime, authorization, {
      module: FakeIdentityModule,
    });

    expect(dynamic.controllers).toEqual([
      WebhookManagementController,
      WebhookPreflightController,
    ]);
    expect(dynamic.imports).toEqual([{ module: FakeIdentityModule }]);
    expect(dynamic.providers).toEqual(
      expect.arrayContaining([
        { provide: WebhookManagementService, useValue: service },
        { provide: WEBHOOK_AUTHORIZATION, useValue: authorization },
        WebhookReadGuard,
        WebhookUpdateGuard,
      ]),
    );
  });

  it('resolves the controller and both guards through Nest injection', async () => {
    const testing = await Test.createTestingModule({
      imports: [
        WebhookModule.register(runtime, authorization, {
          module: FakeIdentityModule,
        }),
      ],
    }).compile();
    try {
      expect(testing.get(WebhookManagementController)).toBeInstanceOf(
        WebhookManagementController,
      );
      expect(testing.get(WebhookPreflightController)).toBeInstanceOf(
        WebhookPreflightController,
      );
      expect(testing.get(WebhookReadGuard)).toBeInstanceOf(WebhookReadGuard);
      expect(testing.get(WebhookUpdateGuard)).toBeInstanceOf(
        WebhookUpdateGuard,
      );
    } finally {
      await testing.close();
    }
  });

  it('does not invoke a mutation after workspace authorization denies it', async () => {
    authorization.findAccess.mockClear();
    webhookOperations.provision.mockClear();
    const testing = await Test.createTestingModule({
      imports: [
        WebhookModule.register(runtime, authorization, {
          module: FakeIdentityModule,
        }),
      ],
    }).compile();
    const adapter = new FastifyAdapter();
    const application = testing.createNestApplication(adapter);
    try {
      await application.init();
      const server = adapter.getInstance();
      const response = await server.inject({
        method: 'POST',
        url: '/v1/workspaces/cccccccc-cccc-4ccc-8ccc-cccccccccccc/workflows/dddddddd-dddd-4ddd-8ddd-dddddddddddd/triggers/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/webhook/provision',
        headers: {
          cookie: 'pertexo_session=session-token',
          'idempotency-key': 'webhook-denied',
        },
      });

      expect(response.statusCode).not.toBe(200);
      expect(authorization.findAccess).toHaveBeenCalledOnce();
      expect(webhookOperations.provision).not.toHaveBeenCalled();
    } finally {
      await application.close();
    }
  });
});
