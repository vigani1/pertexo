import { Module, type DynamicModule } from '@nestjs/common';

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
import { ScheduleManagementController } from './controllers.js';
import {
  SCHEDULE_AUTHORIZATION,
  ScheduleReadGuard,
  ScheduleUpdateGuard,
} from './guards.js';
import { ScheduleManagementService } from './service.js';

@Module({})
// Nest dynamic modules require a class container.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class ScheduleModule {
  public static register(
    service: ScheduleManagementService,
    authorization: WorkspaceAuthorizationSource,
    identityModule: DynamicModule,
  ): DynamicModule {
    return {
      module: ScheduleModule,
      imports: [identityModule],
      controllers: [ScheduleManagementController],
      providers: [
        { provide: ScheduleManagementService, useValue: service },
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
        { provide: SCHEDULE_AUTHORIZATION, useValue: authorization },
        ScheduleReadGuard,
        ScheduleUpdateGuard,
      ],
    };
  }
}
