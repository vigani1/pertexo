import { storedAttemptCheckpoint } from '../../support/attempts/handler.js';
import type { NodeAttemptRunStore } from '@pertexo/core/testing';

import { WorkflowEngineError } from '@pertexo/workflow-engine';
import { vi } from 'vitest';
import { createNodeAttemptHandler } from '../../../src/testing.js';
import {
  projection,
  registryPreparedAttempt,
} from '../../support/attempts/handler.js';

export const STORED_CHECKPOINT = storedAttemptCheckpoint(
  '33333333-3333-4333-8333-333333333333',
);

export function heartbeatCancellationHandler(
  runStore: NodeAttemptRunStore,
  executorControlsDispatch = false,
) {
  return createNodeAttemptHandler({
    engine: {
      prepare: vi.fn().mockReturnValue(registryPreparedAttempt()),
    },
    heartbeatIntervalMillis: 10,
    leaseDurationSeconds: 1,
    reader: {
      close: vi.fn().mockResolvedValue(undefined),
      readForExecution: vi.fn().mockResolvedValue(projection()),
    },
    registry: {
      ...(executorControlsDispatch
        ? { dispatchMode: () => 'executor_controlled' as const }
        : {}),
      execute: vi.fn(
        (input: { signal: AbortSignal }): Promise<never> =>
          new Promise((_resolve, reject) => {
            input.signal.addEventListener(
              'abort',
              () => {
                reject(
                  new WorkflowEngineError(
                    'attempt_aborted',
                    'durable cancellation',
                  ),
                );
              },
              { once: true },
            );
          }),
      ),
    },
    runStore,
    workerId: 'worker-1',
  });
}
