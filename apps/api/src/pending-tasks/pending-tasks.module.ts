import { Module, type DynamicModule } from '@nestjs/common';
import type { PendingTaskOperations } from './pending-task-operations.types.js';
import type { WorkspaceAuthorizationSource } from '../workspaces/ports.js';
import { PendingTasksController } from './pending-tasks.controller.js';
import { PENDING_TASKS } from './pending-tasks.tokens.js';
import { WORKSPACE_AUTHORIZATION } from '../workspaces/tokens.js';
@Module({})
// Nest dynamic modules require a class container.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class PendingTasksModule {
  static register(
    store: PendingTaskOperations,
    authorization: WorkspaceAuthorizationSource,
    identityModule: DynamicModule,
  ): DynamicModule {
    return {
      module: PendingTasksModule,
      imports: [identityModule],
      controllers: [PendingTasksController],
      providers: [
        { provide: PENDING_TASKS, useValue: store },
        { provide: WORKSPACE_AUTHORIZATION, useValue: authorization },
      ],
    };
  }
}
