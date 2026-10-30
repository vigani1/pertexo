import type { DynamicModule, Provider } from '@nestjs/common';
import { Module } from '@nestjs/common';
import type { WorkspaceDatabase } from '@pertexo/database/platform';

export const WORKSPACE_DATABASE = Symbol('WORKSPACE_DATABASE');

@Module({})
// Nest requires a class as the module identity passed through dynamic registration.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class DatabaseModule {
  public static register(database: WorkspaceDatabase): DynamicModule {
    const databaseProvider: Provider = {
      provide: WORKSPACE_DATABASE,
      useValue: database,
    };

    return {
      module: DatabaseModule,
      providers: [databaseProvider],
      exports: [databaseProvider],
    };
  }
}
