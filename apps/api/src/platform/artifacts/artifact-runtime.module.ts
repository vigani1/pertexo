import type { DynamicModule, OnApplicationShutdown } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { createDualRegionArtifactStore } from '@pertexo/artifact-store';
import {
  createArtifactUploadDatabase,
  type DatabaseConfig,
  type DatabaseRuntime,
} from '@pertexo/database/api';

import {
  ArtifactsModule,
  type ArtifactDependencies,
  type ArtifactUploadDatabase,
  type ArtifactStore,
} from '../../artifacts/index.js';
import type { ApiConfig } from '../config/api-config.js';
import type { ApiIdentityRuntime } from '../identity/identity-runtime.module.js';

export const DEFAULT_ARTIFACT_MAX_OBJECT_BYTES = 10 * 1024 * 1024;

export type ApiArtifactRuntime = Readonly<{
  dependencies: ArtifactDependencies;
  checkReadiness(): Promise<void>;
  close(): Promise<void>;
}>;

export type ApiArtifactRuntimeOverrides = Readonly<{
  database?: ArtifactUploadDatabase;
  databaseFactory?: typeof createArtifactUploadDatabase;
  store?: ArtifactStore;
}>;

export function createApiArtifactRuntime(
  config: NonNullable<ApiConfig['artifacts']>,
  databaseConfig: DatabaseConfig,
  identityRuntime: ApiIdentityRuntime,
  overrides: ApiArtifactRuntimeOverrides = {},
  databaseRuntime?: DatabaseRuntime,
): ApiArtifactRuntime {
  const store =
    overrides.store ??
    createDualRegionArtifactStore(config.primary, config.recovery);
  let database: ArtifactUploadDatabase;
  try {
    database =
      overrides.database ??
      overrides.databaseFactory?.(databaseConfig, databaseRuntime) ??
      createArtifactUploadDatabase(databaseConfig, databaseRuntime);
  } catch (error: unknown) {
    closeStore(store, error);
    throw error;
  }
  const dependencies = Object.freeze({
    authorization: identityRuntime.dependencies.authorization,
    database,
    store,
  });
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    dependencies,
    checkReadiness: async (): Promise<void> => {
      await Promise.all([store.checkReadiness(), database.checkReadiness()]);
    },
    close: (): Promise<void> => {
      closePromise ??= closeResources(database, store);
      return closePromise;
    },
  });
}

async function closeResources(
  database: ArtifactUploadDatabase,
  store: ArtifactStore,
): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => database.close()),
    Promise.resolve().then(() => {
      store.close();
    }),
  ]);
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );
  if (failures.length > 0)
    throw new AggregateError(failures, 'Artifact resource shutdown failed');
}

function closeStore(store: ArtifactStore, original: unknown): void {
  try {
    store.close();
  } catch (closeError: unknown) {
    throw new AggregateError(
      [original, closeError],
      'Artifact runtime construction and cleanup failed',
    );
  }
}

class ArtifactRuntimeShutdown implements OnApplicationShutdown {
  public constructor(private readonly runtime: ApiArtifactRuntime) {}

  public async onApplicationShutdown(): Promise<void> {
    await this.runtime.close();
  }
}

@Module({})
// Nest dynamic modules require a class container.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class ArtifactRuntimeModule {
  public static register(
    runtime: ApiArtifactRuntime,
    identityModule: DynamicModule,
    options: Readonly<{ maxObjectBytes: number }>,
  ): DynamicModule {
    return {
      module: ArtifactRuntimeModule,
      imports: [
        ArtifactsModule.register(runtime.dependencies, identityModule, {
          maxObjectBytes: options.maxObjectBytes,
        }),
      ],
      providers: [
        {
          provide: ArtifactRuntimeShutdown,
          useFactory: () => new ArtifactRuntimeShutdown(runtime),
        },
      ],
    };
  }
}
