import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type {
  ScheduleTriggerDatabase,
  WebhookTriggerDatabase,
} from '@pertexo/database/api';
import {
  WebhookTriggerEnvelopeEncryption,
  type WebhookEnvelopeKeyProvider,
} from '@pertexo/integrations/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { APPLICATION_ERROR_MAPPERS } from '../../src/application-error-mappers.js';
import { IdentityWorkspaceModule } from '../../src/identity-workspace/module.js';
import type { IdentityWorkspaceDependencies } from '../../src/identity-workspace/ports.js';
import { HttpPlatformModule } from '../../src/platform/http/http.module.js';
import { ScheduleModule } from '../../src/schedules/module.js';
import { ScheduleManagementService } from '../../src/schedules/service.js';
import { WebhookModule } from '../../src/webhooks/module.js';
import { WebhookManagementService } from '../../src/webhooks/service.js';
import type {
  WorkspaceAccess,
  WorkspaceAccessQuery,
} from '../../src/workspaces/index.js';

const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workflowId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const triggerId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sessionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

let authenticated = false;

const sessionLookup = vi.fn<
  IdentityWorkspaceDependencies['persistence']['findByDigest']
>(() =>
  Promise.resolve(
    authenticated
      ? {
          sessionId,
          tokenDigest: 'a'.repeat(64),
          userId,
          expiresAt: new Date(Date.now() + 60_000),
          clientMetadata: {},
        }
      : undefined,
  ),
);
const authorizationLookup = vi.fn<
  (query: WorkspaceAccessQuery) => Promise<WorkspaceAccess | undefined>
>(() =>
  Promise.resolve(
    authenticated
      ? {
          actorId: userId,
          workspaceId,
          role: 'owner' as const,
          membershipStatus: 'active' as const,
          workspaceStatus: 'active' as const,
        }
      : undefined,
  ),
);

const identityDependencies: IdentityWorkspaceDependencies = {
  config: {
    oidc: {
      issuer: 'https://issuer.example.test',
      authorizationEndpoint: 'https://issuer.example.test/authorize',
      clientId: 'client',
      redirectUri: 'https://app.example.test/callback',
      scopes: ['openid'],
      transactionTtlMillis: 300_000,
    },
    session: { secureCookie: false },
  },
  provider: {
    authorizationUrl: () => 'https://issuer.example.test/authorize',
    exchangeCode: () => Promise.reject(new Error('not exercised')),
  },
  transactions: {
    create: () => Promise.resolve(),
    consume: () => Promise.resolve({ status: 'missing' as const }),
  },
  persistence: {
    create: () => Promise.resolve(),
    findByDigest: sessionLookup,
    revokeByDigest: () => Promise.resolve(false),
    resolveOrCreateIdentity: () => Promise.resolve({ userId }),
    createWorkspaceWithOwner: () => Promise.reject(new Error('not exercised')),
    requestWorkspaceLifecycleOperation: () =>
      Promise.reject(new Error('not exercised')),
    readWorkspaceLifecycleOperation: () =>
      Promise.reject(new Error('not exercised')),
  },
  authorization: { findAccess: authorizationLookup },
};

const scheduleDatabase = {
  list: vi
    .fn<ScheduleTriggerDatabase['list']>()
    .mockRejectedValue(new Error('schedule business layer must not be called')),
  setEnabled: vi
    .fn<ScheduleTriggerDatabase['setEnabled']>()
    .mockRejectedValue(new Error('schedule business layer must not be called')),
  checkReadiness: vi
    .fn<ScheduleTriggerDatabase['checkReadiness']>()
    .mockRejectedValue(new Error('schedule business layer must not be called')),
  close: vi.fn<ScheduleTriggerDatabase['close']>().mockResolvedValue(undefined),
} satisfies ScheduleTriggerDatabase;
const webhookDatabase = {
  provision: vi
    .fn<WebhookTriggerDatabase['provision']>()
    .mockRejectedValue(new Error('webhook business layer must not be called')),
  rotateEndpoint: vi
    .fn<WebhookTriggerDatabase['rotateEndpoint']>()
    .mockRejectedValue(new Error('webhook business layer must not be called')),
  rotateSecret: vi
    .fn<WebhookTriggerDatabase['rotateSecret']>()
    .mockRejectedValue(new Error('webhook business layer must not be called')),
  getHealth: vi
    .fn<WebhookTriggerDatabase['getHealth']>()
    .mockRejectedValue(new Error('webhook business layer must not be called')),
  resolveVerification: vi
    .fn<WebhookTriggerDatabase['resolveVerification']>()
    .mockResolvedValue(null),
  consumeIngressLimit: vi
    .fn<WebhookTriggerDatabase['consumeIngressLimit']>()
    .mockResolvedValue(undefined),
  acceptVerifiedDelivery: vi
    .fn<WebhookTriggerDatabase['acceptVerifiedDelivery']>()
    .mockRejectedValue(new Error('webhook business layer must not be called')),
  close: vi.fn<WebhookTriggerDatabase['close']>().mockResolvedValue(undefined),
} satisfies WebhookTriggerDatabase;
const webhookKeys: WebhookEnvelopeKeyProvider = {
  generateDataKey: vi
    .fn<WebhookEnvelopeKeyProvider['generateDataKey']>()
    .mockRejectedValue(new Error('webhook business layer must not be called')),
  decryptDataKey: vi
    .fn<WebhookEnvelopeKeyProvider['decryptDataKey']>()
    .mockRejectedValue(new Error('webhook business layer must not be called')),
};
const scheduleService = new ScheduleManagementService(scheduleDatabase);
const webhookService = new WebhookManagementService(
  webhookDatabase,
  new WebhookTriggerEnvelopeEncryption(webhookKeys),
);

const identityModule = IdentityWorkspaceModule.register(identityDependencies);
const scheduleModule = ScheduleModule.register(
  scheduleService,
  identityDependencies.authorization,
  identityModule,
);
const webhookModule = WebhookModule.register(
  webhookService,
  identityDependencies.authorization,
  identityModule,
);

const httpLogger = { log: () => undefined };

// Nest requires a class as the root module passed to the application factory.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class GuardResolutionRootModule {}

const rootModule = {
  module: GuardResolutionRootModule,
  imports: [
    HttpPlatformModule.register(httpLogger, APPLICATION_ERROR_MAPPERS),
    scheduleModule,
    webhookModule,
  ],
};

describe('feature guard provider resolution', () => {
  let application: NestFastifyApplication | undefined;

  afterEach(async () => {
    authenticated = false;
    vi.clearAllMocks();
    await application?.close();
    application = undefined;
  });

  it('resolves identity guards exported by IdentityWorkspaceModule on multiple feature routes', async () => {
    application = await NestFactory.create<NestFastifyApplication>(
      rootModule,
      new FastifyAdapter(),
      { logger: false, abortOnError: false },
    );
    await application.init();

    const schedulePath = `/v1/workspaces/${workspaceId}/workflows/${workflowId}/triggers/schedules`;
    const webhookPath = `/v1/workspaces/${workspaceId}/workflows/${workflowId}/triggers`;

    const unauthenticatedSchedule = await application.inject({
      method: 'GET',
      url: schedulePath,
    });
    const unauthenticatedWebhook = await application.inject({
      method: 'GET',
      url: webhookPath,
    });
    expect(unauthenticatedSchedule.statusCode).toBe(401);
    expect(unauthenticatedWebhook.statusCode).toBe(401);
    expect(unauthenticatedSchedule.json()).toMatchObject({
      code: 'auth.unauthenticated',
    });
    expect(unauthenticatedWebhook.json()).toMatchObject({
      code: 'auth.unauthenticated',
    });

    authenticated = true;
    const scheduleMutation = await application.inject({
      method: 'POST',
      url: `${schedulePath.replace('/schedules', '')}/${triggerId}/schedule/enable`,
      headers: { cookie: `pertexo_session=${'s'.repeat(43)}` },
      payload: {},
    });
    const webhookMutation = await application.inject({
      method: 'POST',
      url: `${webhookPath}/${triggerId}/webhook/provision`,
      headers: { cookie: `pertexo_session=${'s'.repeat(43)}` },
      payload: {},
    });

    expect(scheduleMutation.statusCode).toBe(403);
    expect(webhookMutation.statusCode).toBe(403);
    expect(scheduleMutation.json()).toMatchObject({
      code: 'auth.forbidden',
      detail: 'The request could not be verified.',
    });
    expect(webhookMutation.json()).toMatchObject({
      code: 'auth.forbidden',
      detail: 'The request could not be verified.',
    });
    expect(scheduleDatabase.setEnabled).not.toHaveBeenCalled();
    expect(webhookDatabase.provision).not.toHaveBeenCalled();
    expect(authorizationLookup).toHaveBeenCalledTimes(2);
    expect(sessionLookup).toHaveBeenCalledTimes(2);
  });
});
