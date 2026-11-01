import type {
  DatabaseConfig,
  DatabaseRuntime,
} from '@pertexo/database/platform';
import type * as Integrations from '@pertexo/integrations/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApiWebhookRuntime } from '../../src/platform/webhooks/runtime.module.js';
import { silentLogger } from '../support/silent-logger.js';

const outside = vi.hoisted(() => ({
  database: vi.fn(),
  testEvents: vi.fn(),
  envelope: vi.fn(),
}));

vi.mock('@pertexo/core/triggers', async (original) => ({
  ...(await original<object>()),
  createWebhookTriggerDatabase: outside.database,
  createWebhookTestEventStore: outside.testEvents,
}));
vi.mock('@pertexo/integrations/server', async (original) => ({
  ...(await original<object>()),
  createWebhookTriggerEnvelopeEncryption: outside.envelope,
}));

const config = {
  kmsKeyReference: 'alias/pertexo-webhooks',
  region: 'test-region',
} as const;
const databaseConfig = {} as DatabaseConfig;
const options = { logger: silentLogger, burstLimit: 600 };

function envelope(close: () => void) {
  return { encryption: {}, close };
}

describe('API webhook runtime ownership', () => {
  beforeEach(() => {
    outside.database.mockReset().mockReturnValue({ close: vi.fn() });
    outside.testEvents.mockReset().mockReturnValue({ close: vi.fn() });
    outside.envelope.mockReset().mockReturnValue(envelope(vi.fn()));
  });

  it('composes the real local envelope without creating an AWS client', async () => {
    const actual = await vi.importActual<typeof Integrations>(
      '@pertexo/integrations/server',
    );
    outside.envelope.mockImplementation(
      actual.createWebhookTriggerEnvelopeEncryption,
    );
    const databaseClose = vi.fn();
    outside.database.mockReturnValue({ close: databaseClose });
    const runtime = await createApiWebhookRuntime(
      {
        mode: 'self-managed',
        encryption: {
          current: {
            version: '1',
            key: Buffer.alloc(32, 4).toString('base64'),
          },
          previous: [],
        },
      },
      databaseConfig,
      options,
    );
    const context = {
      workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      triggerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      secretVersionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    };
    const sealed = await runtime.ingress.encryption.seal(
      new Uint8Array(32).fill(9),
      context,
    );
    const opened = await runtime.ingress.encryption.open(sealed, context);
    expect(opened).toEqual(new Uint8Array(32).fill(9));
    opened.fill(0);
    await runtime.close();
    expect(databaseClose).toHaveBeenCalledOnce();
  });

  it('defers and aggregates every closer once in reverse acquisition order', async () => {
    const envelopeFailure = new Error('envelope close failed');
    const databaseFailure = new Error('database close rejected');
    const envelopeClose = vi.fn(() => {
      throw envelopeFailure;
    });
    const databaseClose = vi.fn().mockRejectedValue(databaseFailure);
    outside.database.mockReturnValue({ close: databaseClose });
    outside.envelope.mockReturnValue(envelope(envelopeClose));
    const runtime = await createApiWebhookRuntime(
      config,
      databaseConfig,
      options,
    );

    const first = runtime.close();
    const second = runtime.close();

    expect(second).toBe(first);
    const failure = await first.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      envelopeFailure,
      databaseFailure,
    ]);
    await expect(second).rejects.toBe(failure);
    expect(envelopeClose).toHaveBeenCalledOnce();
    expect(databaseClose).toHaveBeenCalledOnce();
  });

  it('closes the database when envelope construction fails', async () => {
    const constructionFailure = new Error('envelope construction failed');
    const databaseClose = vi.fn();
    outside.database.mockReturnValue({ close: databaseClose });
    outside.envelope.mockImplementation(() => {
      throw constructionFailure;
    });

    await expect(
      createApiWebhookRuntime(config, databaseConfig, options),
    ).rejects.toBe(constructionFailure);
    expect(databaseClose).toHaveBeenCalledOnce();
  });

  it('preserves envelope construction and database cleanup failures', async () => {
    const constructionFailure = new Error('envelope construction failed');
    const cleanupFailure = new Error('database cleanup failed');
    outside.database.mockReturnValue({
      close: () => Promise.reject(cleanupFailure),
    });
    outside.envelope.mockImplementation(() => {
      throw constructionFailure;
    });
    const failure = await createApiWebhookRuntime(
      config,
      databaseConfig,
      options,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      constructionFailure,
      cleanupFailure,
    ]);
  });

  it('cleans both acquired owners if later service composition fails', async () => {
    const databaseClose = vi.fn();
    const envelopeClose = vi.fn();
    const invalidEnvelope = envelope(envelopeClose);
    Object.defineProperty(invalidEnvelope, 'encryption', {
      get: () => {
        throw new Error('encryption projection failed');
      },
    });
    outside.database.mockReturnValue({ close: databaseClose });
    outside.envelope.mockReturnValue(invalidEnvelope);

    await expect(
      createApiWebhookRuntime(config, databaseConfig, options),
    ).rejects.toThrow('encryption projection failed');
    expect(envelopeClose).toHaveBeenCalledOnce();
    expect(databaseClose).toHaveBeenCalledOnce();
  });

  it('passes the shared runtime to the database lease factories', async () => {
    const sharedRuntime = {} as DatabaseRuntime;
    const databaseClose = vi.fn();
    const envelopeClose = vi.fn();
    outside.database.mockReturnValue({ close: databaseClose });
    outside.envelope.mockReturnValue(envelope(envelopeClose));
    const runtime = await createApiWebhookRuntime(config, databaseConfig, {
      ...options,
      runtime: sharedRuntime,
    });

    await runtime.close();
    expect(outside.database).toHaveBeenCalledExactlyOnceWith(
      databaseConfig,
      sharedRuntime,
      { burstLimit: 600 },
    );
    expect(outside.testEvents).toHaveBeenCalledExactlyOnceWith(
      databaseConfig,
      sharedRuntime,
    );
    expect(envelopeClose).toHaveBeenCalledOnce();
    expect(databaseClose).toHaveBeenCalledOnce();
  });
});
