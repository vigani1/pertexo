import { describe, expect, it } from 'vitest';

import { parseWorkerConfig } from '../src/config/worker-config.js';

describe('parseWorkerConfig', () => {
  it('applies safe defaults when optional environment values are absent', () => {
    expect(
      parseWorkerConfig({
        DATABASE_WORKER_URL:
          'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
      }),
    ).toEqual({
      database: {
        connectionString:
          'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
        max: 5,
        ownerRole: 'pertexo_owner',
      },
      nodeEnv: 'development',
      logLevel: 'info',
      observability: {
        environment: 'development',
        logLevel: 'info',
        otlpHeaders: {},
        serviceName: 'pertexo-worker',
        serviceVersion: '0.0.0-dev',
      },
    });
  });

  it('returns the typed worker settings for valid environment values', () => {
    const config = parseWorkerConfig({
      DATABASE_WORKER_URL:
        'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
      NODE_ENV: 'test',
      LOG_LEVEL: 'debug',
    });

    expect(config).toEqual({
      database: {
        connectionString:
          'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
        max: 5,
        ownerRole: 'pertexo_owner',
      },
      nodeEnv: 'test',
      logLevel: 'debug',
      observability: {
        environment: 'test',
        logLevel: 'debug',
        otlpHeaders: {},
        serviceName: 'pertexo-worker',
        serviceVersion: '0.0.0-dev',
      },
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.database)).toBe(true);
  });

  it('rejects an unsupported log level before the worker starts', () => {
    expect(() =>
      parseWorkerConfig({
        DATABASE_WORKER_URL:
          'postgresql://pertexo_worker:secret@localhost:5432/pertexo',
        LOG_LEVEL: 'verbose',
      }),
    ).toThrow(/invalid worker configuration/i);
  });
});
