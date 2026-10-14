import { ApiTokenAuthentication } from '../authentication/automation/authority.js';
import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { ApiTokenDatabase } from '@pertexo/database/tenant-access';
import type { IdentityClock } from '../identity/index.js';
import { AutomationAuthenticationGuard } from '../authentication/automation/guard.js';
import { HttpRateLimitAdmission } from '../platform/rate-limit/admission.js';
import { ApiTokenController } from './controller.js';
import { ApiTokenManagement } from './use-cases.js';

export type ApiTokenDependencies = Readonly<{
  database: ApiTokenDatabase;
  enabled: boolean;
  clock: IdentityClock;
}>;
@Module({})
// Nest dynamic modules require a class container.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class ApiTokenModule {
  public static register(
    identity: DynamicModule,
    admission: DynamicModule,
    dependencies: ApiTokenDependencies,
  ): DynamicModule {
    return {
      module: ApiTokenModule,
      imports: [identity, admission],
      controllers: [ApiTokenController],
      providers: [
        {
          provide: ApiTokenManagement,
          useFactory: () =>
            new ApiTokenManagement(
              dependencies.database,
              dependencies.enabled,
              dependencies.clock,
            ),
        },
        {
          provide: ApiTokenAuthentication,
          inject: [HttpRateLimitAdmission],
          useFactory: (limits: HttpRateLimitAdmission) =>
            new ApiTokenAuthentication(
              dependencies.database,
              dependencies.enabled,
              limits,
            ),
        },
        AutomationAuthenticationGuard,
      ],
      exports: [AutomationAuthenticationGuard, ApiTokenAuthentication],
    };
  }
}
