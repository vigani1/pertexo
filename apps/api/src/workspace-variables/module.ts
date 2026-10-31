import { Module, type DynamicModule } from '@nestjs/common';
import type { WorkspaceVariablesStore } from '@pertexo/core/server';
import type { WorkspaceAuthorizationSource } from '../workspaces/ports.js';
import { WorkspaceVariablesController } from './controller.js';
import { WorkspaceVariablesService } from './service.js';
import {
  VARIABLES_AUTHORIZATION,
  WorkspaceVariablesReadGuard,
  WorkspaceVariablesManageGuard,
} from './guards.js';
@Module({})
// Nest dynamic modules require a class container.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class WorkspaceVariablesModule {
  static register(
    store: WorkspaceVariablesStore,
    authorization: WorkspaceAuthorizationSource,
    identityModule: DynamicModule,
  ): DynamicModule {
    return {
      module: WorkspaceVariablesModule,
      imports: [identityModule],
      controllers: [WorkspaceVariablesController],
      providers: [
        {
          provide: WorkspaceVariablesService,
          useValue: new WorkspaceVariablesService(store),
        },
        { provide: VARIABLES_AUTHORIZATION, useValue: authorization },
        WorkspaceVariablesReadGuard,
        WorkspaceVariablesManageGuard,
      ],
    };
  }
}
