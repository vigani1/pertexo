import { Module, type DynamicModule } from '@nestjs/common';

import type { WorkspaceAuthorizationSource } from '../workspaces/ports.js';
import { ScheduleManagementController } from './controllers.js';
import { WORKSPACE_AUTHORIZATION } from '../workspaces/tokens.js';
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
        { provide: WORKSPACE_AUTHORIZATION, useValue: authorization },
      ],
    };
  }
}
