import type { StructuredLogger } from '@pertexo/observability/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseWorkerConfig } from '../../src/config/worker.js';
import { configuredRetentionRuntime } from '../../src/retention/composition.js';
import { workerEnvironment } from '../support/worker-environment.js';

// Nothing listens here, so each cycle ends quickly and shows in the log.
const config = parseWorkerConfig({
  ...workerEnvironment,
  DATABASE_MAINTENANCE_URL:
    'postgresql://pertexo_maintenance:secret@127.0.0.1:1/pertexo',
  ARTIFACT_STORE_ENDPOINT: 'http://127.0.0.1:1',
});

describe('the worker’s retention loop', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // An idle install used to be woken every second to find nothing to do.
  it('waits a minute between cycles when no operation has work left', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const logger = { error: vi.fn() };
    const runtime = configuredRetentionRuntime(
      config,
      logger as unknown as StructuredLogger,
    );
    const failedCycles = () => logger.error.mock.calls.length;
    try {
      runtime.start();
      await expect(runtime.checkReadiness()).rejects.toThrow();
      expect(failedCycles()).toBe(1);

      await vi.advanceTimersByTimeAsync(59_999);
      expect(failedCycles()).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => {
        expect(failedCycles()).toBe(2);
      });
    } finally {
      await runtime.close();
    }
  });
});
