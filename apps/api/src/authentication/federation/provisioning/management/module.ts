import { Module, type DynamicModule } from '@nestjs/common';
import { DirectoryManagementController } from './controller.js';
import { DirectoryManagementService } from './service.js';
@Module({})
// Nest dynamic modules require a class container.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class DirectoryManagementModule {
  static register(
    service: DirectoryManagementService,
    identity: DynamicModule,
    admission: DynamicModule,
  ): DynamicModule {
    return {
      module: DirectoryManagementModule,
      imports: [identity, admission],
      controllers: [DirectoryManagementController],
      providers: [{ provide: DirectoryManagementService, useValue: service }],
    };
  }
}
