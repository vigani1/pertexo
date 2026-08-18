import type { WorkspaceDatabase } from '@pertexo/database';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApiApplication } from '../src/app.js';

const database: WorkspaceDatabase = {
  withWorkspace: async <T>(
    _workspaceId: string,
    operation: (transaction: never) => Promise<T>,
  ): Promise<T> => operation(undefined as never),
  checkReadiness: () =>
    Promise.resolve({
      migrationHead: '0000_rls_probe.sql',
      postgresMajor: 18,
      role: 'pertexo_api',
    }),
  close: () => Promise.resolve(),
};

const config = {
  database: {
    connectionString: 'postgresql://pertexo_api:secret@localhost:5432/pertexo',
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: 5,
    ownerRole: 'pertexo_owner',
  },
  host: '127.0.0.1',
  nodeEnv: 'test' as const,
  port: 3000,
};

describe('API bootstrap', () => {
  let application: Awaited<ReturnType<typeof createApiApplication>> | undefined;

  afterEach(async () => {
    await application?.close();
    application = undefined;
  });

  it('serves a stable bounded liveness response without dependency claims', async () => {
    application = await createApiApplication(config, database);
    await application.init();

    const response = await application.inject({
      method: 'GET',
      url: '/health/live',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.payload).toBe('{"status":"ok"}');
    expect(response.payload.length).toBeLessThanOrEqual(64);
  });

  it('reports readiness only after database compatibility passes', async () => {
    application = await createApiApplication(config, database);
    await application.init();

    const response = await application.inject({
      method: 'GET',
      url: '/health/ready',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready' });
  });

  it('returns 503 without exposing a database readiness failure', async () => {
    const unavailableDatabase: WorkspaceDatabase = {
      ...database,
      checkReadiness: vi
        .fn()
        .mockRejectedValue(new Error('secret database detail')),
    };
    application = await createApiApplication(config, unavailableDatabase);
    await application.init();

    const response = await application.inject({
      method: 'GET',
      url: '/health/ready',
    });

    expect(response.statusCode).toBe(503);
    expect(response.payload).not.toContain('secret database detail');
  });
});
