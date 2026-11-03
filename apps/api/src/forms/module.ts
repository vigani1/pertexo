import { Module, type DynamicModule } from '@nestjs/common';
import type { FormStore } from '@pertexo/core/triggers';
import type { WorkspaceAuthorizationSource } from '../workspaces/ports.js';
import { FormService } from './form.service.js';
import { MemberFormsController } from './members.controller.js';
import { PublicFormsController } from './public.controller.js';
import { WORKSPACE_AUTHORIZATION } from '../workspaces/tokens.js';
@Module({})
// Nest dynamic modules require a class container.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class FormsModule {
  static register(
    store: FormStore,
    authorization: WorkspaceAuthorizationSource,
    identityModule: DynamicModule,
    admission: DynamicModule,
  ): DynamicModule {
    return {
      module: FormsModule,
      imports: [identityModule, admission],
      controllers: [MemberFormsController, PublicFormsController],
      providers: [
        { provide: FormService, useValue: new FormService(store) },
        { provide: WORKSPACE_AUTHORIZATION, useValue: authorization },
      ],
    };
  }
}
