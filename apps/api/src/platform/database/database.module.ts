import type {
  DynamicModule,
  OnApplicationShutdown,
  Provider,
} from '@nestjs/common';
import { Module } from '@nestjs/common';
import type {
  DatabaseConfig,
  WorkspaceDatabase,
  WorkspaceTransaction,
  WorkspaceTransactionOptions,
} from '@pertexo/database';
import { createWorkspaceDatabase } from '@pertexo/database';
import { CORE_REGISTRY_RELEASE } from '@pertexo/nodes-core';
import {
  composeExecutableCompatibilityRelease,
  describeExecutableCompatibilityRelease,
} from '@pertexo/workflow-engine';

export const WORKSPACE_DATABASE = Symbol('WORKSPACE_DATABASE');

export class NestWorkspaceDatabase
  implements WorkspaceDatabase, OnApplicationShutdown
{
  public constructor(private readonly database: WorkspaceDatabase) {}

  public withWorkspace<T>(
    workspaceId: string,
    operation: (transaction: WorkspaceTransaction) => Promise<T>,
    options?: WorkspaceTransactionOptions,
  ): Promise<T> {
    return this.database.withWorkspace(workspaceId, operation, options);
  }

  public checkReadiness(): ReturnType<WorkspaceDatabase['checkReadiness']> {
    return this.database.checkReadiness();
  }

  public close(): ReturnType<WorkspaceDatabase['close']> {
    return this.database.close();
  }

  public async onApplicationShutdown(): Promise<void> {
    await this.close();
  }
}

type DatabaseModuleOptions = Readonly<{
  database?: WorkspaceDatabase;
}>;

function createDatabaseProvider(
  config: DatabaseConfig,
  options: DatabaseModuleOptions,
): Provider {
  return {
    provide: WORKSPACE_DATABASE,
    useFactory: (): NestWorkspaceDatabase =>
      new NestWorkspaceDatabase(
        options.database ??
          createWorkspaceDatabase(config, {
            compatibilityRelease: describeExecutableCompatibilityRelease(
              composeExecutableCompatibilityRelease(CORE_REGISTRY_RELEASE),
            ),
          }),
      ),
  };
}

@Module({})
// Nest requires a class as the module identity passed through dynamic registration.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class DatabaseModule {
  public static register(
    config: DatabaseConfig,
    options: DatabaseModuleOptions = {},
  ): DynamicModule {
    const databaseProvider = createDatabaseProvider(config, options);

    return {
      module: DatabaseModule,
      providers: [databaseProvider],
      exports: [databaseProvider],
    };
  }
}
