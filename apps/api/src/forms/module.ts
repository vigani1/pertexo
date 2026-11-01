import { Module, type DynamicModule } from '@nestjs/common';
import type { FormStore } from '@pertexo/core/triggers';
import type { WorkspaceAuthorizationSource } from '../workspaces/ports.js';
import { FormService } from './service.js';
import { MemberFormsController } from './members.controller.js';
import { PublicFormsController } from './public.controller.js';
import {
  FormMemberGuard,
  FormManageGuard,
  FORM_AUTHORIZATION,
} from './guards.js';
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
        { provide: FORM_AUTHORIZATION, useValue: authorization },
        FormMemberGuard,
        FormManageGuard,
      ],
    };
  }
}
