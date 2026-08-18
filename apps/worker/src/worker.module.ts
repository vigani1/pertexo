import 'reflect-metadata';

import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { WorkspaceDatabase } from '@pertexo/database';

import type { WorkerConfig } from './config/worker-config.js';
import { DatabaseModule } from './platform/database/database.module.js';

@Module({})
// Nest requires a class as the root module passed to the application factory.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class WorkerModule {
  public static register(
    config: WorkerConfig,
    database?: WorkspaceDatabase,
  ): DynamicModule {
    const databaseOptions = database === undefined ? {} : { database };

    return {
      module: WorkerModule,
      imports: [DatabaseModule.register(config.database, databaseOptions)],
    };
  }
}
