import { Module, type DynamicModule } from '@nestjs/common';
import type { GovernanceStore } from '@pertexo/database/governance';
import type { WorkspaceAuthorizationSource } from '../workspaces/ports.js';
import { GovernanceController } from './controller.js';
import { GOVERNANCE_STORE } from './tokens.js';
import {
  GOVERNANCE_AUTHORIZATION,
  GovernanceGuard,
  GovernanceManageGuard,
} from './guard.js';
@Module({})
// Nest dynamic modules require a class container.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class GovernanceModule {
  static register(
    store: GovernanceStore,
    authorization: WorkspaceAuthorizationSource,
    identity: DynamicModule,
    admission: DynamicModule,
  ): DynamicModule {
    return {
      module: GovernanceModule,
      imports: [identity, admission],
      controllers: [GovernanceController],
      providers: [
        { provide: GOVERNANCE_STORE, useValue: store },
        { provide: GOVERNANCE_AUTHORIZATION, useValue: authorization },
        GovernanceGuard,
        GovernanceManageGuard,
      ],
    };
  }
}
