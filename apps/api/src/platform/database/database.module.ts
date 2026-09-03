import type {
  DynamicModule,
  OnApplicationShutdown,
  Provider,
} from '@nestjs/common';
import { Module } from '@nestjs/common';
import type { DatabaseConfig, WorkspaceDatabase } from '@pertexo/database/api';
import { createWorkspaceDatabase } from '@pertexo/database/api';
import {
  platformRegistryReleaseSupport,
  type PlatformReleaseCohort,
} from '@pertexo/node-catalog';
import {
  composeExecutableCompatibilityRelease,
  createExecutableCompatibilityReleaseSupport,
} from '@pertexo/workflow-engine';

export const WORKSPACE_DATABASE = Symbol('WORKSPACE_DATABASE');

class NestWorkspaceDatabase
  implements WorkspaceDatabase, OnApplicationShutdown
{
  public constructor(private readonly database: WorkspaceDatabase) {}

  public withWorkspace: WorkspaceDatabase['withWorkspace'] = (
    workspaceId,
    operation,
    options,
  ) => this.database.withWorkspace(workspaceId, operation, options);

  public checkReadiness(): ReturnType<WorkspaceDatabase['checkReadiness']> {
    return this.database.checkReadiness();
  }

  public checkCompatibility(): ReturnType<
    WorkspaceDatabase['checkCompatibility']
  > {
    return this.database.checkCompatibility();
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
  releaseCohort: PlatformReleaseCohort;
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
            compatibilityReleases: createExecutableCompatibilityReleaseSupport(
              platformRegistryReleaseSupport(options.releaseCohort).map(
                composeExecutableCompatibilityRelease,
              ),
            ).descriptions,
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
