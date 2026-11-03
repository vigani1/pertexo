import { createWorkflowTriggerPauseFoldStore } from '@pertexo/core/triggers';
import type { StructuredLogger } from '@pertexo/observability';

import type { WorkerConfig } from '../config/worker.js';

import {
  createWorkflowAutoPauseRuntime,
  type WorkflowAutoPauseRuntime,
} from './auto-pause-runtime.js';

/** ADR 056: an injected runtime, else the fold loop. */
export function configuredWorkflowAutoPauseRuntime(
  { workflowAutoPause: config, retention }: WorkerConfig,
  dependencies: Readonly<{
    workflowAutoPauseRuntime?: WorkflowAutoPauseRuntime;
    logger: StructuredLogger;
  }>,
): WorkflowAutoPauseRuntime {
  const { logger } = dependencies;
  return createWorkflowAutoPauseRuntime(
    createWorkflowTriggerPauseFoldStore(retention.maintenanceDatabase),
    {
      foldBatchSize: config.foldBatchSize,
      foldPollMillis: config.foldPollMillis,
    },
    {
      cycleFailed: (error) => {
        logger.error('workflow_auto_pause.cycle_failed', {}, error);
      },
      decided: (decision) => {
        logger.warn('workflow_auto_pause.paused', {
          workspaceId: decision.workspaceId,
          workflowId: decision.workflowId,
          consecutiveFailures: decision.consecutiveFailures,
        });
      },
    },
  );
}
