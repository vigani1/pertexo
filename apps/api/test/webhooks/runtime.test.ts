import type {
  createWebhookTriggerDatabase,
  DatabaseConfig,
  DatabaseRuntime,
  WebhookTriggerDatabase,
} from '@pertexo/database/api';
import type {
  createAwsWebhookTriggerEnvelopeEncryption,
  WebhookTriggerEnvelopeEncryption,
} from '@pertexo/integrations/server';
import { describe, expect, it, vi } from 'vitest';

import { createApiWebhookRuntime } from '../../src/platform/webhooks/webhook-runtime.module.js';

const config = {
  kmsKeyReference: 'alias/pertexo-webhooks',
  region: 'test-region',
} as const;
const databaseConfig = {} as DatabaseConfig;
const encryption = {} as WebhookTriggerEnvelopeEncryption;

function database(close: () => Promise<void> | void): WebhookTriggerDatabase {
  return { close } as unknown as WebhookTriggerDatabase;
}

function envelope(close: () => void) {
  return { encryption, close } as ReturnType<
    typeof createAwsWebhookTriggerEnvelopeEncryption
  >;
}

describe('API webhook runtime ownership', () => {
  it('defers and aggregates every closer once in reverse acquisition order', async () => {
    const envelopeFailure = new Error('envelope close failed');
    const databaseFailure = new Error('database close rejected');
    const envelopeClose = vi.fn(() => {
      throw envelopeFailure;
    });
    const databaseClose = vi.fn().mockRejectedValue(databaseFailure);
    const runtime = await createApiWebhookRuntime(
      config,
      databaseConfig,
      'core',
      database(databaseClose),
      undefined,
      { envelope: () => envelope(envelopeClose) },
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

    await expect(
      createApiWebhookRuntime(
        config,
        databaseConfig,
        'core',
        database(databaseClose),
        undefined,
        {
          envelope: () => {
            throw constructionFailure;
          },
        },
      ),
    ).rejects.toBe(constructionFailure);
    expect(databaseClose).toHaveBeenCalledOnce();
  });

  it('preserves envelope construction and database cleanup failures', async () => {
    const constructionFailure = new Error('envelope construction failed');
    const cleanupFailure = new Error('database cleanup failed');
    const failure = await createApiWebhookRuntime(
      config,
      databaseConfig,
      'core',
      database(() => Promise.reject(cleanupFailure)),
      undefined,
      {
        envelope: () => {
          throw constructionFailure;
        },
      },
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

    await expect(
      createApiWebhookRuntime(
        config,
        databaseConfig,
        'core',
        database(databaseClose),
        undefined,
        { envelope: () => invalidEnvelope },
      ),
    ).rejects.toThrow('encryption projection failed');
    expect(envelopeClose).toHaveBeenCalledOnce();
    expect(databaseClose).toHaveBeenCalledOnce();
  });

  it('passes compatibility and the shared runtime to the database lease factory', async () => {
    const sharedRuntime = {} as DatabaseRuntime;
    const databaseClose = vi.fn();
    const envelopeClose = vi.fn();
    const factory = vi.fn(
      (
        _config: DatabaseConfig,
        descriptions: unknown,
        selectedRuntime?: DatabaseRuntime,
      ) => {
        expect(descriptions).toBeDefined();
        expect(selectedRuntime).toBe(sharedRuntime);
        return database(databaseClose);
      },
    ) as unknown as typeof createWebhookTriggerDatabase;
    const runtime = await createApiWebhookRuntime(
      config,
      databaseConfig,
      'core',
      undefined,
      sharedRuntime,
      {
        database: factory,
        envelope: () => envelope(envelopeClose),
      },
    );

    await runtime.close();
    expect(factory).toHaveBeenCalledOnce();
    expect(envelopeClose).toHaveBeenCalledOnce();
    expect(databaseClose).toHaveBeenCalledOnce();
  });
});
