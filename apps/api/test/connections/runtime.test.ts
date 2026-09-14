import type {
  ApiConnectionDatabase,
  DatabaseConfig,
  DatabaseRuntime,
} from '@pertexo/database/api';
import type { AwsConnectionEnvelopeEncryptionRuntime } from '@pertexo/integrations/server';
import { describe, expect, it, vi } from 'vitest';

import {
  createApiConnectionRuntime,
  type ApiConnectionRuntimeOverrides,
} from '../../src/platform/connections/connection-runtime.module.js';
import type { ApiIdentityRuntime } from '../../src/platform/identity/identity-runtime.module.js';
import type {
  ConnectionEmailClient,
  ConnectionHttpClient,
  ConnectionSecretEncryptionPort,
  ConnectionSlackClient,
} from '../../src/connections/index.js';

const config = {
  kmsKeyReference: 'alias/pertexo-connections',
  region: 'test-region',
} as const;
const databaseConfig = {} as DatabaseConfig;
const identityRuntime = {
  dependencies: { authorization: {} },
} as ApiIdentityRuntime;
const encryption = {} as ConnectionSecretEncryptionPort;
const httpClient = {} as ConnectionHttpClient;
const slackClient = {} as ConnectionSlackClient;
const emailClient = {} as ConnectionEmailClient;
const telemetry = {
  measure: <T>(_operation: string, work: () => Promise<T>): Promise<T> =>
    work(),
};

function database(close: () => Promise<void> | void): ApiConnectionDatabase {
  return { close } as unknown as ApiConnectionDatabase;
}

function destinationDatabase(close: () => Promise<void> | void) {
  return { close } as unknown as ReturnType<
    NonNullable<
      NonNullable<
        ApiConnectionRuntimeOverrides['persistence']
      >['destinationDatabaseFactory']
    >
  >;
}

describe('API connection runtime ownership', () => {
  it('defers every close and aggregates synchronous and asynchronous failures in owner order', async () => {
    const databaseFailure = new Error('database close failed');
    const destinationFailure = new Error('destination close failed');
    const encryptionFailure = new Error('encryption close failed');
    const databaseClose = vi.fn(() => {
      throw databaseFailure;
    });
    const destinationClose = vi.fn(() => Promise.reject(destinationFailure));
    const encryptionClose = vi.fn(() => {
      throw encryptionFailure;
    });
    const runtime = await createApiConnectionRuntime(
      config,
      databaseConfig,
      identityRuntime,
      {
        persistence: {
          database: database(databaseClose),
          destinationDatabaseFactory: () =>
            destinationDatabase(destinationClose),
        },
        encryption: {
          factory: () =>
            ({
              encryption,
              close: encryptionClose,
            }) as unknown as AwsConnectionEnvelopeEncryptionRuntime,
        },
        telemetry: { value: telemetry },
        clients: {
          http: httpClient,
          slack: slackClient,
          email: emailClient,
        },
      },
    );

    const first = runtime.close();
    const second = runtime.close();
    expect(second).toBe(first);
    const failure = await first.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      databaseFailure,
      destinationFailure,
      encryptionFailure,
    ]);
    expect(databaseClose).toHaveBeenCalledOnce();
    expect(destinationClose).toHaveBeenCalledOnce();
    expect(encryptionClose).toHaveBeenCalledOnce();
  });

  it.each([
    ['destination database', ['database']],
    ['encryption', ['database', 'destination']],
    ['telemetry', ['database', 'destination', 'encryption']],
    ['HTTP client', ['database', 'destination', 'encryption']],
    ['Slack client', ['database', 'destination', 'encryption']],
    ['email client', ['database', 'destination', 'encryption']],
  ] as const)(
    'closes every acquired owner when %s construction fails',
    async (stage, expectedClosed) => {
      const constructionFailure = new Error(`${stage} construction failed`);
      const closed: string[] = [];
      const connectionDatabase = database(() => {
        closed.push('database');
      });
      const overrides: ApiConnectionRuntimeOverrides = {
        persistence: {
          database: connectionDatabase,
          destinationDatabaseFactory: () => {
            if (stage === 'destination database') throw constructionFailure;
            return destinationDatabase(() => {
              closed.push('destination');
            });
          },
        },
        encryption: {
          factory: () => {
            if (stage === 'encryption') throw constructionFailure;
            return {
              encryption,
              close: () => {
                closed.push('encryption');
              },
            } as AwsConnectionEnvelopeEncryptionRuntime;
          },
        },
        telemetry: {
          factory: () => {
            if (stage === 'telemetry') throw constructionFailure;
            return telemetry;
          },
        },
        clients: {
          httpFactory: () => {
            if (stage === 'HTTP client') throw constructionFailure;
            return httpClient;
          },
          slackFactory: () => {
            if (stage === 'Slack client') throw constructionFailure;
            return slackClient;
          },
          emailFactory: () => {
            if (stage === 'email client') throw constructionFailure;
            return emailClient;
          },
        },
      };

      await expect(
        createApiConnectionRuntime(
          config,
          databaseConfig,
          identityRuntime,
          overrides,
        ),
      ).rejects.toBe(constructionFailure);
      expect(closed).toEqual(expectedClosed);
    },
  );

  it('preserves construction and cleanup failures without closing injected encryption', async () => {
    const constructionFailure = new Error('email construction failed');
    const cleanupFailure = new Error('database cleanup failed');
    const destinationClose = vi.fn();
    const injectedEncryptionClose = vi.fn();
    const injectedEncryption = {
      ...encryption,
      close: injectedEncryptionClose,
    } as ConnectionSecretEncryptionPort & { close(): void };

    const failure = await createApiConnectionRuntime(
      config,
      databaseConfig,
      identityRuntime,
      {
        persistence: {
          database: database(() => Promise.reject(cleanupFailure)),
          destinationDatabaseFactory: () =>
            destinationDatabase(destinationClose),
        },
        encryption: { value: injectedEncryption },
        telemetry: { value: telemetry },
        clients: {
          http: httpClient,
          slack: slackClient,
          emailFactory: () => {
            throw constructionFailure;
          },
        },
      },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      constructionFailure,
      cleanupFailure,
    ]);
    expect(destinationClose).toHaveBeenCalledOnce();
    expect(injectedEncryptionClose).not.toHaveBeenCalled();
  });

  it('passes a shared database runtime to both lease factories and closes each returned lease once', async () => {
    const sharedRuntime = {} as DatabaseRuntime;
    const databaseClose = vi.fn();
    const destinationClose = vi.fn();
    const databaseFactory = vi.fn(
      (_config: DatabaseConfig, selectedRuntime?: DatabaseRuntime) => {
        expect(selectedRuntime).toBe(sharedRuntime);
        return database(databaseClose);
      },
    );
    const destinationFactory = vi.fn(
      (_config: DatabaseConfig, selectedRuntime?: DatabaseRuntime) => {
        expect(selectedRuntime).toBe(sharedRuntime);
        return destinationDatabase(destinationClose);
      },
    );
    const runtime = await createApiConnectionRuntime(
      config,
      databaseConfig,
      identityRuntime,
      {
        persistence: {
          databaseFactory,
          destinationDatabaseFactory: destinationFactory,
        },
        encryption: { value: encryption },
        telemetry: { value: telemetry },
        clients: {
          http: httpClient,
          slack: slackClient,
          email: emailClient,
        },
      },
      sharedRuntime,
    );

    await runtime.close();
    expect(databaseFactory).toHaveBeenCalledOnce();
    expect(destinationFactory).toHaveBeenCalledOnce();
    expect(databaseClose).toHaveBeenCalledOnce();
    expect(destinationClose).toHaveBeenCalledOnce();
  });
});
