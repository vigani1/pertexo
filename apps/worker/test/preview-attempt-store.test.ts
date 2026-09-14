import { randomUUID } from 'node:crypto';

import type * as DatabaseExecution from '@pertexo/database/execution';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  acquire: vi.fn(),
  close: vi.fn(() => Promise.resolve()),
  markDispatched: vi.fn(() => Promise.resolve('committed' as const)),
}));

vi.mock('@pertexo/database/execution', async (importOriginal) => ({
  ...(await importOriginal<typeof DatabaseExecution>()),
  acquireDatabasePool: database.acquire,
  markPreviewDispatched: database.markDispatched,
}));

import { createDatabasePreviewAttemptRunStore } from '../src/execution/preview-attempt-runtime.js';

const config = {
  connectionString: 'postgresql://worker:password@localhost/pertexo',
  connectionTimeoutMillis: 1_000,
  idleTimeoutMillis: 2_000,
  max: 5,
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
} as const;

function lease() {
  return {
    attemptFenceToken: 3,
    previewAttemptId: randomUUID(),
    previewRunId: randomUUID(),
    workspaceId: randomUUID(),
  };
}

describe('database preview attempt store adapter', () => {
  beforeEach(() => {
    database.acquire.mockReset();
    database.close.mockClear();
    database.markDispatched.mockClear();
    database.markDispatched.mockResolvedValue('committed');
    database.acquire.mockReturnValue({
      pool: { name: 'pool' },
      close: database.close,
    });
  });

  it.each([
    ['absent', {}, {}],
    [
      'connection fence alone',
      {
        connectionFence: {
          connectionId: '11111111-1111-4111-8111-111111111111',
          expectedProviderKey: 'email',
          expectedAuthType: 'resend_api_key',
          secretVersionId: '22222222-2222-4222-8222-222222222222',
        },
      },
      {
        connectionFence: {
          connectionId: '11111111-1111-4111-8111-111111111111',
          expectedProviderKey: 'email',
          expectedAuthType: 'resend_api_key',
          secretVersionId: '22222222-2222-4222-8222-222222222222',
        },
      },
    ],
    [
      'provider binding alone',
      { providerDispatchBinding: 'email:v1:sha256:' + 'a'.repeat(64) },
      { providerDispatchBinding: 'email:v1:sha256:' + 'a'.repeat(64) },
    ],
    [
      'both authority fields',
      {
        connectionFence: {
          connectionId: '11111111-1111-4111-8111-111111111111',
          expectedProviderKey: 'email',
          expectedAuthType: 'resend_api_key',
          secretVersionId: '22222222-2222-4222-8222-222222222222',
        },
        providerDispatchBinding: 'email:v1:sha256:' + 'b'.repeat(64),
      },
      {
        connectionFence: {
          connectionId: '11111111-1111-4111-8111-111111111111',
          expectedProviderKey: 'email',
          expectedAuthType: 'resend_api_key',
          secretVersionId: '22222222-2222-4222-8222-222222222222',
        },
        providerDispatchBinding: 'email:v1:sha256:' + 'b'.repeat(64),
      },
    ],
  ] as const)('forwards %s exactly', async (_label, authority, expected) => {
    const store = createDatabasePreviewAttemptRunStore(config);
    const scope = lease();
    const signal = new AbortController().signal;

    await expect(
      store.markDispatched({
        lease: scope,
        ...authority,
        signal,
        workerId: 'worker-preview-test',
      }),
    ).resolves.toBe('committed');
    expect(database.markDispatched).toHaveBeenCalledWith(
      { name: 'pool' },
      {
        lease: scope,
        ...expected,
        signal,
        workerId: 'worker-preview-test',
      },
    );
    await store.close();
  });

  it('validates the complete lease projection before calling persistence', async () => {
    const store = createDatabasePreviewAttemptRunStore(config);
    await expect(
      store.markDispatched({
        lease: { ...lease(), workspaceId: 'not-a-workspace-id' },
        workerId: 'worker-preview-test',
      }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(database.markDispatched).not.toHaveBeenCalled();
    await store.close();
  });
});
