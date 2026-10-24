import { acquireDatabasePool } from '../../platform/pool/runtime.js';
import type { DatabaseRuntime } from '../../platform/pool/runtime.js';

import { z } from 'zod';

import type { DatabaseConfig } from '../../config.js';
import { ScheduleTriggerError } from './errors.js';

import {
  authorizeScheduleReader,
  createScheduleTriggerReads,
} from './reads.queries.js';
import { refreshWorkflowActivation } from '../reconciliation/repository.js';
import { canManageWorkflowTrigger } from '../management.queries.js';
import { withTenantScopedClient } from '../../tenant-access/transactions.js';
import {
  uuidSchema,
  type ScheduleTriggerDatabase,
} from './management/contract.js';
import {
  mapScheduleTrigger,
  scheduleProjection,
  readScheduleCommandTarget,
  scheduleHealthTransition,
} from './management/state.queries.js';
import {
  scheduleCommandIdentity,
  claimScheduleCommand,
  applyScheduleHealthTransition,
  recordScheduleCommandAudit,
  completeScheduleCommand,
} from './management/receipts.repository.js';
export { ScheduleTriggerError } from './errors.js';
export {
  type ScheduleTriggerRecord,
  type ScheduleTriggerCommandResult,
  type ScheduleTriggerDatabase,
} from './management/contract.js';
export function createScheduleTriggerDatabase(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): ScheduleTriggerDatabase {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
  return Object.freeze({
    ...createScheduleTriggerReads(pool),
    list: (input: Parameters<ScheduleTriggerDatabase['list']>[0]) =>
      withTenantScopedClient(
        pool,
        {
          workspaceId: uuidSchema.parse(input.workspaceId),
          actorId: uuidSchema.parse(input.actorId),
        },
        async (client) => {
          const workflowId = uuidSchema.parse(input.workflowId);
          await authorizeScheduleReader(
            client,
            input.workspaceId,
            input.actorId,
            workflowId,
          );
          const result = await client.query<Record<string, unknown>>(
            `${scheduleProjection}
              where schedule.workspace_id=$1 and trigger.workflow_id=$2
                and trigger.kind='schedule'
                and trigger.workflow_version_id=(select published_version_id
                  from app.workflows where workspace_id=$1 and id=$2)
              order by trigger.node_id,trigger.id limit 1000`,
            [input.workspaceId, workflowId],
          );
          return Object.freeze(result.rows.map(mapScheduleTrigger));
        },
      ),
    setEnabled: async (
      input: Parameters<ScheduleTriggerDatabase['setEnabled']>[0],
    ) =>
      withTenantScopedClient(
        pool,
        {
          workspaceId: z.uuid().parse(input.workspaceId),
          actorId: z.uuid().parse(input.actorId),
        },
        async (client) => {
          if (!(await canManageWorkflowTrigger(client, input)))
            throw new ScheduleTriggerError('not_found');
          const identity = scheduleCommandIdentity(input);
          const replay = await claimScheduleCommand(client, input, identity);
          if (replay !== null) return replay;
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
      await pool.query('select 1 from app.trigger_schedules limit 0');
    },
    close: () => lease.close(),
  });
}
