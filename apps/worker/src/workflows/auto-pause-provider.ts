import { createWorkflowTriggerPauseFoldStore } from '@pertexo/database/triggers';
import type { DatabaseRuntime } from '@pertexo/database/platform';
import type { StructuredLogger } from '@pertexo/observability';

import type { WorkerConfig } from '../config/worker.js';

import {
  createWorkflowAutoPauseRuntime,
  type WorkflowAutoPauseRuntime,
} from './auto-pause-runtime.js';

/**
 * ADR 056: an injected runtime, else the configured fold loop, or none while
 * auto-pause is off.
 */
export function configuredWorkflowAutoPauseRuntime(
  { workflowAutoPause: config, database }: WorkerConfig,
  dependencies: Readonly<{
    workflowAutoPauseRuntime?: WorkflowAutoPauseRuntime;
    databaseRuntime?: DatabaseRuntime;
    logger: StructuredLogger;
  }>,
): WorkflowAutoPauseRuntime | undefined {
  if (dependencies.workflowAutoPauseRuntime !== undefined)
    return dependencies.workflowAutoPauseRuntime;
  if (config.mode === 'off') return undefined;
  const { logger } = dependencies;
  return createWorkflowAutoPauseRuntime(
    createWorkflowTriggerPauseFoldStore(database, dependencies.databaseRuntime),
    {
      enforce: config.mode === 'enforce',
      foldBatchSize: config.foldBatchSize,
      foldPollMillis: config.foldPollMillis,
    },
    {
      cycleFailed: () => {
        logger.error('workflow_auto_pause.cycle_failed');
      },
      decided: (decision) => {
        logger.warn(
          decision.paused
            ? 'workflow_auto_pause.paused'
            : 'workflow_auto_pause.would_pause',
          {
            workspaceId: decision.workspaceId,
            workflowId: decision.workflowId,
            consecutiveFailures: decision.consecutiveFailures,
          },
        );
      },
    },
  );
}
