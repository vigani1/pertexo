import { beforeEach, describe, expect, it, vi } from 'vitest';

import { acquireApiRuntimes } from '../../src/api-runtimes.js';
import type { ApiConfig } from '../../src/platform/config/api.js';
import type { ApiIdentityConfig } from '../../src/platform/config/identity.js';
import { silentLogger } from '../support/silent-logger.js';

const created = vi.hoisted(() => ({
  databaseRuntime: vi.fn(),
  database: vi.fn(),
  rateLimit: vi.fn(),
  identity: vi.fn(),
  workflow: vi.fn(),
  connection: vi.fn(),
  callback: vi.fn(),
  schedule: vi.fn(),
  notification: vi.fn(),
}));

vi.mock('@pertexo/database/platform', async (original) => ({
  ...(await original<object>()),
  createDatabaseRuntime: created.databaseRuntime,
  createWorkspaceDatabase: created.database,
}));
vi.mock('@pertexo/rate-limit', async (original) => ({
  ...(await original<object>()),
  RedisRateLimitRuntime: function RedisRateLimitRuntime() {
    return created.rateLimit() as object;
  },
}));
vi.mock('../../src/platform/identity/runtime.module.js', () => ({
  createApiIdentityRuntime: created.identity,
}));
vi.mock('../../src/platform/workflow/runtime.module.js', () => ({
  createApiWorkflowRuntime: created.workflow,
}));
vi.mock('../../src/platform/connections/runtime.module.js', () => ({
  createApiConnectionRuntime: created.connection,
}));
vi.mock('../../src/platform/webhooks/callback-runtime.module.js', () => ({
  createApiCallbackRuntime: created.callback,
}));
vi.mock('../../src/platform/schedules/runtime.module.js', () => ({
  createApiScheduleRuntime: created.schedule,
}));
vi.mock('../../src/platform/notifications/runtime.module.js', () => ({
  createApiNotificationRuntime: created.notification,
}));

const identity = {
  betterAuth: { secret: 'acquisition-secret' },
} as unknown as ApiIdentityConfig;
const config = {
  database: { connectionString: 'postgresql://unused' },
  redisUrl: 'redis://unused',
  identity,
  connections: { kmsKeyReference: 'test-key', region: 'test-region' },
} as unknown as ApiConfig;

function closes(close = vi.fn().mockResolvedValue(undefined)) {
  return { close };
}

describe('API runtime acquisition', () => {
  beforeEach(() => {
    for (const factory of Object.values(created))
      factory.mockReset().mockReturnValue(closes());
    created.identity.mockResolvedValue(closes());
    created.workflow.mockResolvedValue(closes());
    created.connection.mockResolvedValue(closes());
  });

  it('builds identity features only when identity is configured', async () => {
    const runtimes = await acquireApiRuntimes(
      { ...config, identity: undefined } as unknown as ApiConfig,
      { logger: silentLogger, telemetry: {} as never },
    );
    expect(runtimes.identityRuntime).toBeUndefined();
    expect(runtimes.workflowRuntime).toBeUndefined();
    expect(runtimes.connectionRuntime).toBeUndefined();
    expect(created.identity).not.toHaveBeenCalled();
    expect(created.callback).toHaveBeenCalledOnce();
  });

  it('closes already-created runtimes when a later one fails', async () => {
    const failure = new Error('connection construction failed');
    const identityClose = vi.fn().mockResolvedValue(undefined);
    const workflowClose = vi.fn().mockResolvedValue(undefined);
    created.identity.mockResolvedValue(closes(identityClose));
    created.workflow.mockResolvedValue(closes(workflowClose));
    created.connection.mockRejectedValue(failure);

    await expect(
      acquireApiRuntimes(config, {
        logger: silentLogger,
        telemetry: {} as never,
      }),
    ).rejects.toBe(failure);
    expect(identityClose).toHaveBeenCalledOnce();
    expect(workflowClose).toHaveBeenCalledOnce();
  });

  it('preserves the construction failure and every cleanup failure', async () => {
    const failure = new Error('connection construction failed');
    const identityFailure = new Error('identity close failed');
    const workflowFailure = new Error('workflow close failed');
    created.identity.mockResolvedValue(
      closes(vi.fn().mockRejectedValue(identityFailure)),
    );
    created.workflow.mockResolvedValue(
      closes(vi.fn().mockRejectedValue(workflowFailure)),
    );
    created.connection.mockRejectedValue(failure);

    const error = await acquireApiRuntimes(config, {
      logger: silentLogger,
      telemetry: {} as never,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      failure,
      identityFailure,
      workflowFailure,
    ]);
  });
});
