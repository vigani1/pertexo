import { createWorkflowTriggerPauseFoldStore } from '@pertexo/database/triggers';
import type { DatabaseRuntime } from '@pertexo/database/platform';
import type { StructuredLogger } from '@pertexo/observability';

import type { WorkerConfig } from '../config/worker.js';

import {
  createWorkflowAutoPauseRuntime,
  type WorkflowAutoPauseRuntime,
} from './auto-pause-runtime.js';

/** ADR 056: an injected runtime, else the fold loop. */
export function configuredWorkflowAutoPauseRuntime(
  { workflowAutoPause: config, database }: WorkerConfig,
  dependencies: Readonly<{
    workflowAutoPauseRuntime?: WorkflowAutoPauseRuntime;
    databaseRuntime?: DatabaseRuntime;
    logger: StructuredLogger;
  }>,
): WorkflowAutoPauseRuntime {
  if (dependencies.workflowAutoPauseRuntime !== undefined)
    return dependencies.workflowAutoPauseRuntime;
  const { logger } = dependencies;
  return createWorkflowAutoPauseRuntime(
    createWorkflowTriggerPauseFoldStore(database, dependencies.databaseRuntime),
    {
      foldBatchSize: config.foldBatchSize,
      foldPollMillis: config.foldPollMillis,
    },
    {
      cycleFailed: () => {
        logger.error('workflow_auto_pause.cycle_failed');
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
