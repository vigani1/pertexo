import 'reflect-metadata';

import type { DynamicModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import type { WorkspaceDatabase } from '@pertexo/database';

import type { ApiConfig } from './platform/config/api-config.js';

import { DatabaseModule } from './platform/database/database.module.js';
import { LiveController } from './platform/health/live.controller.js';
import { ReadyController } from './platform/health/ready.controller.js';

@Module({
  controllers: [LiveController, ReadyController],
})
// Nest requires a class as the root module passed to the application factory.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class AppModule {
  public static register(
    config: ApiConfig,
    database?: WorkspaceDatabase,
  ): DynamicModule {
    const databaseOptions = database === undefined ? {} : { database };

    return {
      module: AppModule,
      imports: [DatabaseModule.register(config.database, databaseOptions)],
      controllers: [LiveController, ReadyController],
    };
  }
}
