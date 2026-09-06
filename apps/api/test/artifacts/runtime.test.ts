import { describe, expect, it, vi } from 'vitest';
import {
  createArtifactUploadDatabase,
  createDatabaseRuntime,
} from '@pertexo/database/api';
import { parseDatabaseConfig } from '@pertexo/database/testing';

import {
  createApiArtifactRuntime,
  type ApiArtifactRuntimeOverrides,
} from '../../src/platform/artifacts/artifact-runtime.module.js';
import type { ApiConfig } from '../../src/platform/config/api-config.js';
import type { ApiIdentityRuntime } from '../../src/platform/identity/identity-runtime.module.js';
import type {
  ArtifactUploadDatabase,
  ArtifactStore,
} from '../../src/artifacts/index.js';

const config = {
  primary: {
    accessKeyId: 'primary',
    bucket: 'primary-bucket',
    endpoint: 'https://primary.example.test',
    forcePathStyle: true,
    maxObjectBytes: 100,
    region: 'eu-central-1',
    requestTimeoutMs: 1_000,
    secretAccessKey: 'secret',
  },
  recovery: {
    accessKeyId: 'recovery',
    bucket: 'recovery-bucket',
    endpoint: 'https://recovery.example.test',
    forcePathStyle: true,
    maxObjectBytes: 100,
    region: 'eu-west-1',
    requestTimeoutMs: 1_000,
    secretAccessKey: 'secret',
  },
} satisfies NonNullable<ApiConfig['artifacts']>;

const identityRuntime = {
  dependencies: {
    authorization: { findAccess: () => Promise.resolve(undefined) },
  },
  close: vi.fn().mockResolvedValue(undefined),
} as unknown as ApiIdentityRuntime;

function database(): ArtifactUploadDatabase {
  return {
    beginUpload: vi.fn(),
    getForUpload: vi.fn(),
    finalizeUpload: vi.fn(),
    getMetadata: vi.fn(),
    checkReadiness: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function store(): ArtifactStore {
  return {
    beginDirectUpload: vi.fn(),
    validateDirectUpload: vi.fn(),
    beginDirectDownload: vi.fn(),
    checkReadiness: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

describe('API artifact runtime', () => {
  it('forwards a real shared database runtime to the repository factory', async () => {
    const databaseConfig = parseDatabaseConfig({
      connectionString: 'postgresql://unused',
    });
    const sharedRuntime = createDatabaseRuntime(databaseConfig, {});
    const databaseFactory = vi.fn(createArtifactUploadDatabase);
    const runtime = createApiArtifactRuntime(
      config,
      databaseConfig,
      identityRuntime,
      { databaseFactory, store: store() },
      sharedRuntime,
    );
    try {
      expect(databaseFactory).toHaveBeenCalledExactlyOnceWith(
        databaseConfig,
        sharedRuntime,
      );
      await runtime.close();
    } finally {
      await sharedRuntime.close();
    }
  });

  it('closes injected owned resources once', async () => {
    const selectedDatabase = database();
    const selectedStore = store();
    const runtime = createApiArtifactRuntime(
      config,
      { connectionString: 'postgresql://unused' } as never,
      identityRuntime,
      { database: selectedDatabase, store: selectedStore },
    );

    await runtime.checkReadiness();
    await runtime.close();
    await runtime.close();
    expect(selectedDatabase.checkReadiness).toHaveBeenCalledOnce();
    expect(selectedStore.checkReadiness).toHaveBeenCalledOnce();
    expect(selectedDatabase.close).toHaveBeenCalledOnce();
    expect(selectedStore.close).toHaveBeenCalledOnce();
  });

  it('closes the store even when database shutdown throws synchronously', async () => {
    const selectedStore = store();
    const failure = new Error('database close failed');
    const selectedDatabase = {
      ...database(),
      close: () => {
        throw failure;
      },
    };
    const runtime = createApiArtifactRuntime(
      config,
      { connectionString: 'postgresql://unused' } as never,
      identityRuntime,
      { database: selectedDatabase, store: selectedStore },
    );
    await expect(runtime.close()).rejects.toMatchObject({ errors: [failure] });
    await expect(runtime.close()).rejects.toMatchObject({ errors: [failure] });
    expect(selectedStore.close).toHaveBeenCalledOnce();
  });

  it('preserves both composition and store cleanup errors', () => {
    const composition = new Error('database construction failed');
    const cleanup = new Error('store close failed');
    const selectedStore = store();
    selectedStore.close = () => {
      throw cleanup;
    };
    expect(() =>
      createApiArtifactRuntime(
        config,
        { connectionString: 'postgresql://unused' } as never,
        identityRuntime,
        {
          databaseFactory: () => {
            throw composition;
          },
          store: selectedStore,
        },
      ),
    ).toThrow(expect.objectContaining({ errors: [composition, cleanup] }));
  });

  it('cleans the store when database composition fails', () => {
    const selectedStore = store();
    const overrides: ApiArtifactRuntimeOverrides = {
      databaseFactory: () => {
        throw new Error('database construction failed');
      },
      store: selectedStore,
    };
    expect(() =>
      createApiArtifactRuntime(
        config,
        { connectionString: 'postgresql://unused' } as never,
        identityRuntime,
        overrides,
      ),
    ).toThrow('database construction failed');
    expect(selectedStore.close).toHaveBeenCalledOnce();
  });
});
