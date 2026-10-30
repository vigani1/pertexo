import type { WorkspaceDatabase } from '@pertexo/database/testing';

import { expect, it, vi } from 'vitest';
import { createTestApiApplication } from '../../support/api-application.js';

import { ApiDrainState } from '../../../src/platform/health/drain-state.js';

import {
  config,
  database,
  dependencies,
  identityRuntime,
  applicationFixture,
} from '../fixture.js';

export function registerPreservesConstructionEveryRuntimeCleanupFailure(): void {
  it('preserves readiness and cleanup failures when application close rejects', async () => {
    const startupFailure = new Error('database compatibility failed');
    const cleanupFailure = new Error('identity cleanup failed');
    const selectedDatabase: WorkspaceDatabase = {
      ...database,
      checkReadiness: vi.fn().mockRejectedValue(startupFailure),
    };
    const selectedIdentity = identityRuntime(
      vi.fn().mockRejectedValue(cleanupFailure),
    );

    const failure = await createTestApiApplication(config, {
      ...dependencies(selectedDatabase),
      identityRuntime: selectedIdentity,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      startupFailure,
      cleanupFailure,
    ]);
  });

  it('serves a stable bounded liveness response without dependency claims', async () => {
    applicationFixture.application = await createTestApiApplication(
      config,
      dependencies(),
    );
    await applicationFixture.application.init();

    const response = await applicationFixture.application.inject({
      method: 'GET',
      url: '/health/live',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.payload).toBe('{"status":"ok"}');
    expect(response.payload.length).toBeLessThanOrEqual(64);
  });

  it('checks the database at startup and again when asked for readiness', async () => {
    const checkReadiness = vi.fn(() => database.checkReadiness());
    const selectedDatabase: WorkspaceDatabase = {
      ...database,
      checkReadiness,
    };
    applicationFixture.application = await createTestApiApplication(
      config,
      dependencies(selectedDatabase),
    );
    await applicationFixture.application.init();

    const response = await applicationFixture.application.inject({
      method: 'GET',
      url: '/health/ready',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready' });
    expect(checkReadiness).toHaveBeenCalledTimes(2);
  });

  it('returns 503 without exposing a database readiness failure', async () => {
    const readiness = {
      migrationHead: '0000_rls_probe.sql',
      postgresMajor: 18,
      role: 'pertexo_app',
    } as const;
    const unavailableDatabase: WorkspaceDatabase = {
      ...database,
      // Ready at startup, then unavailable.
      checkReadiness: vi
        .fn()
        .mockResolvedValueOnce(readiness)
        .mockRejectedValue(new Error('secret database detail')),
    };
    applicationFixture.application = await createTestApiApplication(
      config,
      dependencies(unavailableDatabase),
    );
    await applicationFixture.application.init();

    const response = await applicationFixture.application.inject({
      method: 'GET',
      url: '/health/ready',
    });

    expect(response.statusCode).toBe(503);
    expect(response.payload).not.toContain('secret database detail');
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(response.headers['x-request-id']).toBeTypeOf('string');
    expect(response.json()).toMatchObject({
      code: 'internal.unexpected',
      requestId: response.headers['x-request-id'],
      status: 503,
    });
  });

  it('refuses to start and closes resources against an incompatible database', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const incompatibleDatabase: WorkspaceDatabase = {
      ...database,
      checkReadiness: vi
        .fn()
        .mockRejectedValue(new Error('migration mismatch')),
      close,
    };

    await expect(
      createTestApiApplication(config, dependencies(incompatibleDatabase)),
    ).rejects.toThrow('migration mismatch');
    expect(close).toHaveBeenCalledOnce();
  });

  it('becomes unready before graceful drain', async () => {
    applicationFixture.application = await createTestApiApplication(
      config,
      dependencies(),
    );
    await applicationFixture.application.init();
    applicationFixture.application.get(ApiDrainState).beginDrain();

    const response = await applicationFixture.application.inject({
      method: 'GET',
      url: '/health/ready',
    });

    expect(response.statusCode).toBe(503);
  });
}
