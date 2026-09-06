import { Module, type DynamicModule } from '@nestjs/common';

import type { WorkspaceAuthorizationSource } from '../identity-workspace/ports.js';
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
        { provide: SCHEDULE_AUTHORIZATION, useValue: authorization },
        ScheduleReadGuard,
        ScheduleUpdateGuard,
      ],
    };
  }
}
