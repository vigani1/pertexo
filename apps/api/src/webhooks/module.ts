import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';

import type { WorkspaceAuthorizationSource } from '../workspaces/ports.js';
import { WebhookPreflightController } from './authentication/preflight.controller.js';
import {
  createWebhookPreflight,
  type WebhookIngressDependencies,
} from './ingress.js';
import { WebhookManagementController } from './controllers.js';
import { WebhookManagementService } from './service.js';
import { WebhookReadGuard, WebhookUpdateGuard } from './guards.js';
import { WEBHOOK_AUTHORIZATION, WEBHOOK_PREFLIGHT } from './tokens.js';
import { UnconfiguredWebhooksController } from './unavailable.js';

@Module({})
// Nest dynamic modules require a class container.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class WebhookModule {
  public static register(
    runtime:
      | Readonly<{
          service: WebhookManagementService;
          ingress: WebhookIngressDependencies;
        }>
      | undefined,
    authorization: WorkspaceAuthorizationSource,
    identityModule: DynamicModule,
  ): DynamicModule {
    return {
      module: WebhookModule,
      imports: [identityModule],
      controllers:
        runtime === undefined
          ? [UnconfiguredWebhooksController]
          : [WebhookManagementController, WebhookPreflightController],
      providers: [
        ...(runtime === undefined
          ? []
          : [
              { provide: WebhookManagementService, useValue: runtime.service },
              {
                provide: WEBHOOK_PREFLIGHT,
                useValue: createWebhookPreflight(runtime.ingress),
              },
            ]),
        { provide: WEBHOOK_AUTHORIZATION, useValue: authorization },
        WebhookReadGuard,
        WebhookUpdateGuard,
      ],
    };
  }
}
