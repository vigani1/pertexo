import { Module, type DynamicModule } from '@nestjs/common';
import type { DataTablesStore } from '@pertexo/core/data-tables';
import type { WorkspaceAuthorizationSource } from '../workspaces/ports.js';
import { DataTablesController } from './data-tables.controller.js';
import { DataTablesService } from './data-tables.service.js';
import { WORKSPACE_AUTHORIZATION } from '../workspaces/tokens.js';
@Module({})
// Nest dynamic modules require a class container.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class DataTablesModule {
  static register(
    store: DataTablesStore,
    authorization: WorkspaceAuthorizationSource,
    identityModule: DynamicModule,
    admissionModule: DynamicModule,
  ): DynamicModule {
    return {
      module: DataTablesModule,
      imports: [identityModule, admissionModule],
      controllers: [DataTablesController],
      providers: [
        { provide: DataTablesService, useValue: new DataTablesService(store) },
        { provide: WORKSPACE_AUTHORIZATION, useValue: authorization },
      ],
    };
  }
}
