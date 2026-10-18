import { Module, type DynamicModule } from '@nestjs/common';
import { FederationManagementController } from './controller.js';
import { FederationManagementService } from './service.js';
@Module({})
// Nest dynamic modules require a class container.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class FederationManagementModule {
  static register(
    service: FederationManagementService,
    identity: DynamicModule,
    admission: DynamicModule,
  ): DynamicModule {
    return {
      module: FederationManagementModule,
      imports: [identity, admission],
      controllers: [FederationManagementController],
      providers: [{ provide: FederationManagementService, useValue: service }],
    };
  }
}
