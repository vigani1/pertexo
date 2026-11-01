import type {
  DatabaseConfig,
  DatabaseRuntime,
} from '@pertexo/database/platform';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApiScheduleRuntime } from '../../src/platform/schedules/runtime.module.js';

const outside = vi.hoisted(() => ({ database: vi.fn(), telemetry: vi.fn() }));

vi.mock('@pertexo/core/triggers', async (original) => ({
  ...(await original<object>()),
  createScheduleTriggerDatabase: outside.database,
}));
vi.mock('../../src/schedules/telemetry.js', async (original) => ({
  ...(await original<object>()),
  createScheduleTelemetry: outside.telemetry,
}));

const databaseConfig = {} as DatabaseConfig;

function database(close: () => Promise<void> | void) {
  return { checkReadiness: vi.fn().mockResolvedValue(undefined), close };
}

describe('API schedule runtime ownership', () => {
  beforeEach(() => {
    outside.database.mockReset();
    outside.telemetry.mockReset().mockReturnValue({});
  });

  it('caches a deferred close when the database throws synchronously', async () => {
    const failure = new Error('database close failed');
    const close = vi.fn(() => {
      throw failure;
    });
    outside.database.mockReturnValue(database(close));
    const runtime = await createApiScheduleRuntime(databaseConfig);

    const first = runtime.close();
    const second = runtime.close();

    expect(second).toBe(first);
    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce();
  });

  it('caches a rejected database close once', async () => {
    const failure = new Error('database close rejected');
    const close = vi.fn().mockRejectedValue(failure);
    outside.database.mockReturnValue(database(close));
    const runtime = await createApiScheduleRuntime(databaseConfig);

    const first = runtime.close();
    const second = runtime.close();

    expect(second).toBe(first);
    await expect(first).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes an acquired database when telemetry construction fails', async () => {
    const constructionFailure = new Error('telemetry construction failed');
    const close = vi.fn();
    outside.database.mockReturnValue(database(close));
    outside.telemetry.mockImplementation(() => {
      throw constructionFailure;
    });

    await expect(createApiScheduleRuntime(databaseConfig)).rejects.toBe(
      constructionFailure,
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it('preserves construction and cleanup failures', async () => {
    const constructionFailure = new Error('telemetry construction failed');
    const cleanupFailure = new Error('database cleanup failed');
    outside.database.mockReturnValue(
      database(() => Promise.reject(cleanupFailure)),
    );
    outside.telemetry.mockImplementation(() => {
      throw constructionFailure;
    });
    const failure = await createApiScheduleRuntime(databaseConfig).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      constructionFailure,
      cleanupFailure,
    ]);
  });

  it('passes the shared database runtime to the lease factory', async () => {
    const sharedRuntime = {} as DatabaseRuntime;
    const close = vi.fn();
    outside.database.mockReturnValue(database(close));
    const runtime = await createApiScheduleRuntime(
      databaseConfig,
      sharedRuntime,
    );

    await runtime.close();
    expect(outside.database).toHaveBeenCalledExactlyOnceWith(
      databaseConfig,
      sharedRuntime,
    );
    expect(close).toHaveBeenCalledOnce();
  });
});
