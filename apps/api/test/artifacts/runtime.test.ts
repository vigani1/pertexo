import type { DatabaseRuntime } from '@pertexo/database/platform';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApiArtifactRuntime } from '../../src/platform/artifacts/runtime.module.js';
import type { ApiConfig } from '../../src/platform/config/api.js';
import type { ApiIdentityRuntime } from '../../src/platform/identity/runtime.module.js';

const outside = vi.hoisted(() => ({
  store: vi.fn(),
  database: vi.fn(),
  formUploads: vi.fn(),
}));

vi.mock('@pertexo/artifact-store', async (original) => ({
  ...(await original<object>()),
  createArtifactStore: outside.store,
}));
vi.mock('@pertexo/core/runs', async (original) => ({
  ...(await original<object>()),
  createArtifactUploadDatabase: outside.database,
  createFormUploadDatabase: outside.formUploads,
}));

const config = {
  accessKeyId: 'artifacts',
  bucket: 'artifacts-bucket',
  endpoint: 'https://artifacts.example.test',
  forcePathStyle: true,
  maxObjectBytes: 100,
  region: 'eu-central-1',
  requestTimeoutMs: 1_000,
  secretAccessKey: 'secret',
} satisfies NonNullable<ApiConfig['artifacts']>;

const databaseConfig = parseDatabaseConfig({
  connectionString: 'postgresql://unused',
});

const identityRuntime = {
  dependencies: {
    authorization: { findAccess: () => Promise.resolve(undefined) },
  },
  close: vi.fn().mockResolvedValue(undefined),
} as unknown as ApiIdentityRuntime;

function closable() {
  return {
    checkReadiness: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('API artifact runtime', () => {
  beforeEach(() => {
    outside.store.mockReset().mockReturnValue(closable());
    outside.database.mockReset().mockReturnValue(closable());
    outside.formUploads.mockReset().mockReturnValue(closable());
  });

  it('forwards the shared database runtime to the repository factories', () => {
    const sharedRuntime = {} as DatabaseRuntime;
    createApiArtifactRuntime(config, databaseConfig, {
      identityRuntime,
      databaseRuntime: sharedRuntime,
    });
    expect(outside.database).toHaveBeenCalledExactlyOnceWith(
      databaseConfig,
      sharedRuntime,
    );
    expect(outside.formUploads).toHaveBeenCalledExactlyOnceWith(
      databaseConfig,
      sharedRuntime,
    );
  });

  it('checks and closes its owned resources once', async () => {
    const store = closable();
    const database = closable();
    const formUploads = closable();
    outside.store.mockReturnValue(store);
    outside.database.mockReturnValue(database);
    outside.formUploads.mockReturnValue(formUploads);
    const runtime = createApiArtifactRuntime(config, databaseConfig, {
      identityRuntime,
    });

    await runtime.checkReadiness();
    await runtime.close();
    await runtime.close();
    expect(database.checkReadiness).toHaveBeenCalledOnce();
    expect(store.checkReadiness).toHaveBeenCalledOnce();
    expect(database.close).toHaveBeenCalledOnce();
    expect(formUploads.close).toHaveBeenCalledOnce();
    expect(store.close).toHaveBeenCalledOnce();
  });

  it('closes the store even when database shutdown throws synchronously', async () => {
    const store = closable();
    const failure = new Error('database close failed');
    outside.store.mockReturnValue(store);
    outside.database.mockReturnValue({
      ...closable(),
      close: () => {
        throw failure;
      },
    });
    const runtime = createApiArtifactRuntime(config, databaseConfig, {
      identityRuntime,
    });
    const firstClose = runtime.close();
    const secondClose = runtime.close();
    expect(secondClose).toBe(firstClose);
    await expect(firstClose).rejects.toMatchObject({ errors: [failure] });
    await expect(secondClose).rejects.toMatchObject({ errors: [failure] });
    expect(store.close).toHaveBeenCalledOnce();
  });

  it('aggregates database rejection and synchronous store close failure once', async () => {
    const databaseFailure = new Error('database close rejected');
    const storeFailure = new Error('store close failed');
    const database = {
      ...closable(),
      close: vi.fn().mockRejectedValue(databaseFailure),
    };
    const store = {
      ...closable(),
      close: vi.fn(() => {
        throw storeFailure;
      }),
    };
    outside.store.mockReturnValue(store);
    outside.database.mockReturnValue(database);
    const runtime = createApiArtifactRuntime(config, databaseConfig, {
      identityRuntime,
    });

    const firstClose = runtime.close();
    const secondClose = runtime.close();
    expect(secondClose).toBe(firstClose);
    await expect(firstClose).rejects.toMatchObject({
      errors: [databaseFailure, storeFailure],
    });
    await expect(secondClose).rejects.toMatchObject({
      errors: [databaseFailure, storeFailure],
    });
    expect(database.close).toHaveBeenCalledOnce();
    expect(store.close).toHaveBeenCalledOnce();
  });

  it('preserves both composition and store cleanup errors', () => {
    const composition = new Error('database construction failed');
    const cleanup = new Error('store close failed');
    outside.store.mockReturnValue({
      ...closable(),
      close: () => {
        throw cleanup;
      },
    });
    outside.database.mockImplementation(() => {
      throw composition;
    });
    expect(() =>
      createApiArtifactRuntime(config, databaseConfig, { identityRuntime }),
    ).toThrow(expect.objectContaining({ errors: [composition, cleanup] }));
  });

  it('cleans the store when database composition fails', () => {
    const store = closable();
    outside.store.mockReturnValue(store);
    outside.database.mockImplementation(() => {
      throw new Error('database construction failed');
    });
    expect(() =>
      createApiArtifactRuntime(config, databaseConfig, { identityRuntime }),
    ).toThrow('database construction failed');
    expect(store.close).toHaveBeenCalledOnce();
  });
});
