import { Module, type DynamicModule } from '@nestjs/common';
import type { PendingTaskStore } from '@pertexo/core/runs';
import type { WorkspaceAuthorizationSource } from '../workspaces/ports.js';
import { PendingTasksController } from './controller.js';
import { PendingTaskService } from './service.js';
import {
  PendingTaskReadGuard,
  ApprovalAudienceGuard,
  TASK_AUTHORIZATION,
} from './guards.js';
@Module({})
// Nest dynamic modules require a class container.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class PendingTasksModule {
  static register(
    store: PendingTaskStore,
    authorization: WorkspaceAuthorizationSource,
    identityModule: DynamicModule,
  ): DynamicModule {
    return {
      module: PendingTasksModule,
      imports: [identityModule],
      controllers: [PendingTasksController],
      providers: [
        {
          provide: PendingTaskService,
          useValue: new PendingTaskService(store),
        },
        { provide: TASK_AUTHORIZATION, useValue: authorization },
        PendingTaskReadGuard,
        ApprovalAudienceGuard,
      ],
    };
  }
}
