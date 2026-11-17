import type { DynamicModule, Provider } from '@nestjs/common';
import { Module } from '@nestjs/common';
import type {
  DatabaseConfig,
  DatabaseRuntime,
  WorkspaceDatabase,
} from '@pertexo/database/platform';
import { createWorkspaceDatabase } from '@pertexo/database/platform';

export const WORKSPACE_DATABASE = Symbol('WORKSPACE_DATABASE');

type DatabaseModuleOptions = Readonly<{
  database?: WorkspaceDatabase;
  runtime?: DatabaseRuntime;
}>;

function createDatabaseProvider(
  config: DatabaseConfig,
  options: DatabaseModuleOptions,
): Provider {
  return {
    provide: WORKSPACE_DATABASE,
    useFactory: (): WorkspaceDatabase =>
      options.database ??
      createWorkspaceDatabase(
        config,
        options.runtime === undefined ? {} : { runtime: options.runtime },
      ),
  };
}

@Module({})
// Nest requires a class as the module identity passed through dynamic registration.
// oxlint-disable-next-line typescript/no-extraneous-class
export class DatabaseModule {
  public static register(
    config: DatabaseConfig,
    options: DatabaseModuleOptions,
  ): DynamicModule {
    const databaseProvider = createDatabaseProvider(config, options);

    return {
      module: DatabaseModule,
      providers: [databaseProvider],
      exports: [databaseProvider],
    };
  }
}
