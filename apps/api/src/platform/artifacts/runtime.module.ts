import type { DynamicModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { createArtifactStore } from '@pertexo/artifact-store';
import {
  createArtifactUploadStore,
  createFormUploadStore,
  type FormUploadStore,
} from '@pertexo/core/artifacts';
import type {
  DatabaseConfig,
  DatabaseRuntime,
} from '@pertexo/database/platform';

import {
  ArtifactsModule,
  type ArtifactDependencies,
  type ArtifactUploadStore,
  type ArtifactStore,
} from '../../artifacts/index.js';
import type { ApiConfig } from '../config/api.js';
import type { ApiIdentityRuntime } from '../identity/runtime.module.js';

export const DEFAULT_ARTIFACT_MAX_OBJECT_BYTES = 10 * 1024 * 1024;

export type ApiArtifactRuntime = Readonly<{
  dependencies: ArtifactDependencies;
  checkReadiness(): Promise<void>;
  close(): Promise<void>;
}>;

export function createApiArtifactRuntime(
  config: NonNullable<ApiConfig['artifacts']>,
  databaseConfig: DatabaseConfig,
  {
    identityRuntime,
    databaseRuntime,
  }: Readonly<{
    identityRuntime: ApiIdentityRuntime;
    databaseRuntime?: DatabaseRuntime | undefined;
  }>,
): ApiArtifactRuntime {
  const store = createArtifactStore(config);
  let database: ArtifactUploadStore;
  let formUploads: FormUploadStore;
  try {
    database = createArtifactUploadStore(databaseConfig, databaseRuntime);
    formUploads = createFormUploadStore(databaseConfig, databaseRuntime);
  } catch (error: unknown) {
    closeStore(store, error);
    throw error;
  }
  const dependencies = Object.freeze({
    authorization: identityRuntime.dependencies.authorization,
    database,
    formUploads,
    store,
  });
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    dependencies,
    checkReadiness: async (): Promise<void> => {
      await Promise.all([store.checkReadiness(), database.checkReadiness()]);
    },
    close: (): Promise<void> => {
      closePromise ??= closeResources([database, formUploads], store);
      return closePromise;
    },
  });
}

async function closeResources(
  databases: readonly Readonly<{ close(): Promise<void> }>[],
  store: ArtifactStore,
): Promise<void> {
  const results = await Promise.allSettled([
    ...databases.map((database) =>
      Promise.resolve().then(() => database.close()),
    ),
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

@Module({})
// Nest dynamic modules require a class container.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class ArtifactRuntimeModule {
  public static register(
    runtime: ApiArtifactRuntime,
    modules: Readonly<{ identity: DynamicModule; admission: DynamicModule }>,
    options: Readonly<{ maxObjectBytes: number }>,
  ): DynamicModule {
    return {
      module: ArtifactRuntimeModule,
      imports: [
        ArtifactsModule.register(runtime.dependencies, modules, {
          maxObjectBytes: options.maxObjectBytes,
        }),
      ],
      providers: [],
    };
  }
}
