import { describe, expect, it } from 'vitest';

import { parseApiConfig } from '../src/platform/config/api-config.js';

describe('parseApiConfig', () => {
  it('uses safe development defaults when optional values are absent', () => {
    const config = parseApiConfig({
      DATABASE_API_URL:
        'postgresql://pertexo_api:secret@localhost:5432/pertexo',
    });

    expect(config).toEqual({
      database: {
        connectionString:
          'postgresql://pertexo_api:secret@localhost:5432/pertexo',
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
        max: 5,
      },
      host: '0.0.0.0',
      nodeEnv: 'development',
      port: 3000,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('parses valid environment values into the typed public config', () => {
    const config = parseApiConfig({
      DATABASE_API_URL:
        'postgresql://pertexo_api:secret@localhost:5432/pertexo',
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      PORT: '4312',
    });

    expect(config).toEqual({
      database: {
        connectionString:
          'postgresql://pertexo_api:secret@localhost:5432/pertexo',
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
        max: 5,
      },
      host: '127.0.0.1',
      nodeEnv: 'test',
      port: 4312,
    });
  });

  it('accepts the staging deployment environment', () => {
    expect(
      parseApiConfig({
        DATABASE_API_URL:
          'postgresql://pertexo_api:secret@localhost:5432/pertexo',
        NODE_ENV: 'staging',
      }).nodeEnv,
    ).toBe('staging');
  });

  it('rejects a port outside the TCP port range', () => {
    expect(() =>
      parseApiConfig({
        DATABASE_API_URL:
          'postgresql://pertexo_api:secret@localhost:5432/pertexo',
        PORT: '70000',
      }),
    ).toThrow();
  });
});
