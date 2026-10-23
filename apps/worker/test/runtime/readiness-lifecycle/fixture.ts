import { vi } from 'vitest';
import type { WorkerReadinessMarker } from '../../../src/runtime/health/readiness-monitor.js';

export type SetReady = WorkerReadinessMarker['setReady'];

export const logger = {
  debug: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  info: vi.fn(),
  trace: vi.fn(),
  warn: vi.fn(),
};

export function marker(): WorkerReadinessMarker & {
  ready: boolean;
  setReady: ReturnType<typeof vi.fn<SetReady>>;
} {
  const state = {
    ready: false,
    setReady: vi.fn<SetReady>(({ ready }) => {
      state.ready = ready;
      return Promise.resolve();
    }),
  };
  return state;
}

export function idleRuntime() {
  return { checkReadiness: vi.fn().mockResolvedValue(undefined) } as never;
}

export function resetAppsWorkerTestRuntimeReadinessLifecycleWorkerReadinessLifecycleFixture() {
  vi.clearAllMocks();
}

export function cleanAppsWorkerTestRuntimeReadinessLifecycleWorkerReadinessLifecycleFixture() {
  vi.useRealTimers();
}
