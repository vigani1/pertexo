import { WORKSPACE_VARIABLES_STORE } from './workspace-variables.tokens.js';
import { Module, type DynamicModule } from '@nestjs/common';
import type { WorkspaceVariablesStore } from '@pertexo/core/variables';
import type { WorkspaceAuthorizationSource } from '../workspaces/ports.js';
import { WORKSPACE_AUTHORIZATION } from '../workspaces/tokens.js';
import { WorkspaceVariablesController } from './workspace-variables.controller.js';
import { WorkspaceVariablesService } from './workspace-variables.service.js';
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
        { provide: WORKSPACE_VARIABLES_STORE, useValue: store },
        {
          provide: WorkspaceVariablesService,
          useValue: new WorkspaceVariablesService(store),
        },
        { provide: WORKSPACE_AUTHORIZATION, useValue: authorization },
      ],
    };
  }
}
