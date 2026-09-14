import type {
  createScheduleTriggerDatabase,
  DatabaseConfig,
  DatabaseRuntime,
  ScheduleTriggerDatabase,
} from '@pertexo/database/api';
import { describe, expect, it, vi } from 'vitest';

import { createApiScheduleRuntime } from '../../src/platform/schedules/schedule-runtime.module.js';
import { NOOP_SCHEDULE_TELEMETRY } from '../../src/schedules/telemetry.js';

const databaseConfig = {} as DatabaseConfig;

function database(close: () => Promise<void> | void): ScheduleTriggerDatabase {
  return {
    checkReadiness: vi.fn().mockResolvedValue(undefined),
    close,
  } as unknown as ScheduleTriggerDatabase;
}

describe('API schedule runtime ownership', () => {
  it('caches a deferred close when the database throws synchronously', async () => {
    const failure = new Error('database close failed');
    const close = vi.fn(() => {
      throw failure;
    });
    const runtime = await createApiScheduleRuntime(
      databaseConfig,
      database(close),
      undefined,
      { telemetry: () => NOOP_SCHEDULE_TELEMETRY },
    );

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
    const runtime = await createApiScheduleRuntime(
      databaseConfig,
      database(close),
      undefined,
      { telemetry: () => NOOP_SCHEDULE_TELEMETRY },
    );

    const first = runtime.close();
    const second = runtime.close();

    expect(second).toBe(first);
    await expect(first).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes an acquired database when telemetry construction fails', async () => {
    const constructionFailure = new Error('telemetry construction failed');
    const close = vi.fn();

    await expect(
      createApiScheduleRuntime(databaseConfig, database(close), undefined, {
        telemetry: () => {
          throw constructionFailure;
        },
      }),
    ).rejects.toBe(constructionFailure);
    expect(close).toHaveBeenCalledOnce();
  });

  it('preserves construction and cleanup failures', async () => {
    const constructionFailure = new Error('telemetry construction failed');
    const cleanupFailure = new Error('database cleanup failed');
    const failure = await createApiScheduleRuntime(
      databaseConfig,
      database(() => Promise.reject(cleanupFailure)),
      undefined,
      {
        telemetry: () => {
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

  it('passes the shared database runtime to the selected lease factory', async () => {
    const sharedRuntime = {} as DatabaseRuntime;
    const close = vi.fn();
    const factory = vi.fn(
      (_config: DatabaseConfig, selectedRuntime?: DatabaseRuntime) => {
        expect(selectedRuntime).toBe(sharedRuntime);
        return database(close);
      },
    ) as unknown as typeof createScheduleTriggerDatabase;
    const runtime = await createApiScheduleRuntime(
      databaseConfig,
      undefined,
      sharedRuntime,
      { database: factory, telemetry: () => NOOP_SCHEDULE_TELEMETRY },
    );

    await runtime.close();
    expect(factory).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
