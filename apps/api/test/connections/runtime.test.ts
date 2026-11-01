import type {
  DatabaseConfig,
  DatabaseRuntime,
} from '@pertexo/database/platform';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApiConnectionRuntime } from '../../src/platform/connections/runtime.module.js';
import type { ApiIdentityRuntime } from '../../src/platform/identity/runtime.module.js';

const outside = vi.hoisted(() => ({
  database: vi.fn(),
  destination: vi.fn(),
  encryption: vi.fn(),
  telemetry: vi.fn(),
  http: vi.fn(),
  slack: vi.fn(),
  email: vi.fn(),
}));

vi.mock('@pertexo/core/connections', async (original) => ({
  ...(await original<object>()),
  createConnectionDatabase: outside.database,
}));
vi.mock('@pertexo/core/notifications', async (original) => ({
  ...(await original<object>()),
  createFailureNotificationDestinationDatabase: outside.destination,
}));
vi.mock('@pertexo/integrations/server', async (original) => ({
  ...(await original<object>()),
  createConnectionEnvelopeEncryption: outside.encryption,
  createNodeSecureHttpClient: outside.http,
  createSlackClient: outside.slack,
  createResendClient: outside.email,
}));
vi.mock('../../src/connections/index.js', async (original) => ({
  ...(await original<object>()),
  createConnectionTelemetry: outside.telemetry,
}));

const config = {
  kmsKeyReference: 'alias/pertexo-connections',
  region: 'test-region',
} as const;
const databaseConfig = {} as DatabaseConfig;
const identityRuntime = {
  dependencies: { authorization: {} },
} as ApiIdentityRuntime;
const options = {
  identityRuntime,
  applicationSecret: 'fixture-application-secret',
};

describe('API connection runtime ownership', () => {
  beforeEach(() => {
    for (const service of Object.values(outside)) service.mockReset();
    outside.database.mockReturnValue({ close: vi.fn() });
    outside.destination.mockReturnValue({ close: vi.fn() });
    outside.encryption.mockReturnValue({ encryption: {}, close: vi.fn() });
    outside.telemetry.mockReturnValue({});
    outside.http.mockReturnValue({});
    outside.slack.mockReturnValue({});
    outside.email.mockReturnValue({});
  });

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
    outside.database.mockReturnValue({ close: databaseClose });
    outside.destination.mockReturnValue({ close: destinationClose });
    outside.encryption.mockReturnValue({
      encryption: {},
      close: encryptionClose,
    });
    const runtime = await createApiConnectionRuntime(
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
      databaseFailure,
      destinationFailure,
      encryptionFailure,
    ]);
    expect(databaseClose).toHaveBeenCalledOnce();
    expect(destinationClose).toHaveBeenCalledOnce();
    expect(encryptionClose).toHaveBeenCalledOnce();
  });

  it.each([
    ['destination database', 'destination', ['database']],
    ['encryption', 'encryption', ['database', 'destination']],
    ['telemetry', 'telemetry', ['database', 'destination', 'encryption']],
    ['HTTP client', 'http', ['database', 'destination', 'encryption']],
    ['Slack client', 'slack', ['database', 'destination', 'encryption']],
    ['email client', 'email', ['database', 'destination', 'encryption']],
  ] as const)(
    'closes every acquired owner when %s construction fails',
    async (stage, service, expectedClosed) => {
      const constructionFailure = new Error(`${stage} construction failed`);
      const closed: string[] = [];
      outside.database.mockReturnValue({
        close: () => {
          closed.push('database');
        },
      });
      outside.destination.mockReturnValue({
        close: () => {
          closed.push('destination');
        },
      });
      outside.encryption.mockReturnValue({
        encryption: {},
        close: () => {
          closed.push('encryption');
        },
      });
      outside[service].mockImplementation(() => {
        throw constructionFailure;
      });

      await expect(
        createApiConnectionRuntime(config, databaseConfig, options),
      ).rejects.toBe(constructionFailure);
      expect(closed).toEqual(expectedClosed);
    },
  );

  it('preserves construction and cleanup failures', async () => {
    const constructionFailure = new Error('email construction failed');
    const cleanupFailure = new Error('database cleanup failed');
    const destinationClose = vi.fn();
    outside.database.mockReturnValue({
      close: () => Promise.reject(cleanupFailure),
    });
    outside.destination.mockReturnValue({ close: destinationClose });
    outside.email.mockImplementation(() => {
      throw constructionFailure;
    });

    const failure = await createApiConnectionRuntime(
      config,
      databaseConfig,
      options,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      constructionFailure,
      cleanupFailure,
    ]);
    expect(destinationClose).toHaveBeenCalledOnce();
  });

  it('passes a shared database runtime to both lease factories and closes each returned lease once', async () => {
    const sharedRuntime = {} as DatabaseRuntime;
    const databaseClose = vi.fn();
    const destinationClose = vi.fn();
    outside.database.mockReturnValue({ close: databaseClose });
    outside.destination.mockReturnValue({ close: destinationClose });
    const runtime = await createApiConnectionRuntime(config, databaseConfig, {
      ...options,
      runtime: sharedRuntime,
    });

    await runtime.close();
    expect(outside.database).toHaveBeenCalledExactlyOnceWith(
      databaseConfig,
      sharedRuntime,
    );
    expect(outside.destination).toHaveBeenCalledExactlyOnceWith(
      databaseConfig,
      sharedRuntime,
    );
    expect(databaseClose).toHaveBeenCalledOnce();
    expect(destinationClose).toHaveBeenCalledOnce();
  });
});
