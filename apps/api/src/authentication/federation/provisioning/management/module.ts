import { Module, type DynamicModule } from '@nestjs/common';
import { DirectoryManagementController } from './controller.js';
import { DIRECTORY_STORE } from './tokens.js';
import type { DirectoryStore } from '@pertexo/core/tenant-access';
@Module({})
// Nest dynamic modules require a class container.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class DirectoryManagementModule {
  static register(
    store: DirectoryStore,
    identity: DynamicModule,
    admission: DynamicModule,
  ): DynamicModule {
    return {
      module: DirectoryManagementModule,
      imports: [identity, admission],
      controllers: [DirectoryManagementController],
      providers: [{ provide: DIRECTORY_STORE, useValue: store }],
    };
  }
}
