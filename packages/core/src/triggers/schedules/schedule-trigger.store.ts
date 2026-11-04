import { reconcileActiveWorkflowTriggers } from '../reconciliation/materialization.repository.js';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type {
  DatabaseRuntime,
  DatabaseConfig,
} from '@pertexo/database/platform';
import { acquireDatabasePool } from '@pertexo/database/platform';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import { triggerSchedules, workflowTriggers } from '@pertexo/database/schema';

import { ScheduleTriggerError } from './schedule-trigger.errors.js';

import { withTriggerManagement } from '../management.js';
import { refreshWorkflowActivation } from '../reconciliation/health.repository.js';
import type {
  ListSchedulesInput,
  ScheduleTriggerCommandResult,
  SetEnabledInput,
} from './management/schedule-management.types.js';
import {
  applyScheduleHealthTransition,
  claimScheduleCommand,
  completeScheduleCommand,
  recordScheduleCommandAudit,
  scheduleCommandIdentity,
} from './management/receipts.repository.js';
import {
  readScheduleCommandTarget,
  readSchedules,
  scheduleHealthTransition,
} from './management/schedule-state.repository.js';
import {
  createScheduleTriggerReads,
  withScheduleReader,
} from './schedule-reads.repository.js';
export type ScheduleTriggerStore = ReturnType<
  typeof createScheduleTriggerStore
>;

export function createScheduleTriggerStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
  return Object.freeze({
    ...createScheduleTriggerReads(pool),
    list: (input: ListSchedulesInput) =>
      withScheduleReader(pool, input, (client) =>
        readSchedules(client, input.workspaceId, input.workflowId),
      ),
    setEnabled: (
      input: SetEnabledInput,
    ): Promise<ScheduleTriggerCommandResult> =>
      withTriggerManagement(
        pool,
        input,
        () => new ScheduleTriggerError('not_found'),
        async (client) => {
          const identity = scheduleCommandIdentity(input);
          const replay = await claimScheduleCommand(client, input, identity);
          if (replay !== null) return replay;
          const [publication] = await drizzle(client)
            .select({ versionId: workflowTriggers.workflowVersionId })
            .from(workflowTriggers)
            .where(
              and(
                eq(workflowTriggers.workspaceId, input.workspaceId),
                eq(workflowTriggers.workflowId, identity.workflowId),
                eq(workflowTriggers.id, identity.triggerId),
                eq(workflowTriggers.kind, 'schedule'),
              ),
            )
            .catch(rethrowQueryFailure);
          if (publication === undefined)
            throw new ScheduleTriggerError('not_found');
          // Workflow authority is already locked. Complete publication before reading
          // the command's cursor so a delayed delivery cannot replace this choice.
          await reconcileActiveWorkflowTriggers(client, {
            workspaceId: input.workspaceId,
            workflowId: identity.workflowId,
            versionId: publication.versionId,
          });
          const target = await readScheduleCommandTarget(
            client,
            input,
            identity,
          );
          const transition = scheduleHealthTransition(input, target);
          await applyScheduleHealthTransition(
            client,
            input.workspaceId,
            identity.triggerId,
            transition,
          );
          await refreshWorkflowActivation(
            client,
            input.workspaceId,
            target.workflow_id,
          );
          await recordScheduleCommandAudit(client, input, identity);
          return completeScheduleCommand(client, input, identity);
        },
      ),
    checkReadiness: async () => {
      await drizzle(pool)
        .select({ one: sql`1` })
        .from(triggerSchedules)
        .limit(0)
        .catch(rethrowQueryFailure);
    },
    close: () => lease.close(),
  });
}
