import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';

import {
  DoubleSubmitCsrfPolicy,
  OpaqueSessionService,
} from '../identity/index.js';
import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
} from '../identity-workspace/guards.js';
import type { WorkspaceAuthorizationSource } from '../identity-workspace/ports.js';
import { RequestContextStore } from '../platform/http/index.js';
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
        {
          provide: SessionAuthenticationGuard,
          useFactory: (
            sessions: OpaqueSessionService,
            contexts: RequestContextStore,
          ) => new SessionAuthenticationGuard(sessions, contexts),
          inject: [OpaqueSessionService, RequestContextStore],
        },
        {
          provide: CsrfProtectionGuard,
          useFactory: (csrf: DoubleSubmitCsrfPolicy) =>
            new CsrfProtectionGuard(csrf),
          inject: [DoubleSubmitCsrfPolicy],
        },
        { provide: WEBHOOK_AUTHORIZATION, useValue: authorization },
        WebhookReadGuard,
        WebhookUpdateGuard,
      ],
    };
  }
}
