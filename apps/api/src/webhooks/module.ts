import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';

import type { WorkspaceAuthorizationSource } from '../identity-workspace/ports.js';
import { WebhookManagementController } from './controllers.js';
import { WebhookManagementService } from './service.js';
import {
  WEBHOOK_AUTHORIZATION,
  WebhookReadGuard,
  WebhookUpdateGuard,
} from './guards.js';

@Module({})
// Nest dynamic modules require a class container.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class WebhookModule {
  public static register(
    service: WebhookManagementService,
    authorization: WorkspaceAuthorizationSource,
    identityModule: DynamicModule,
  ): DynamicModule {
    return {
      module: WebhookModule,
      imports: [identityModule],
      controllers: [WebhookManagementController],
      providers: [
        { provide: WebhookManagementService, useValue: service },
        { provide: WEBHOOK_AUTHORIZATION, useValue: authorization },
        WebhookReadGuard,
        WebhookUpdateGuard,
      ],
    };
  }
}
