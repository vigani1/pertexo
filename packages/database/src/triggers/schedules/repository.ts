import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { triggerSchedules } from '../../schema/triggers/schedules.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { acquireDatabasePool } from '../../platform/pool/runtime.js';
import type { DatabaseRuntime } from '../../platform/pool/runtime.js';

import { z } from 'zod';

import type { DatabaseConfig } from '../../config.js';
import { ScheduleTriggerError } from './errors.js';

import {
  authorizeScheduleReader,
  createScheduleTriggerReads,
} from './reads.queries.js';
import { refreshWorkflowActivation } from '../reconciliation/health.repository.js';
import { canManageWorkflowTrigger } from '../management.queries.js';
import { withTenantScopedClient } from '../../tenant-access/transactions.js';
import { uuidSchema } from './input.js';
import type { ScheduleTriggerDatabase } from './management/contract.js';
import {
  readSchedules,
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
          return readSchedules(client, input.workspaceId, workflowId);
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
      await drizzle(pool)
        .select({ one: sql`1` })
        .from(triggerSchedules)
        .limit(0)
        .catch(rethrowQueryFailure);
    },
    close: () => lease.close(),
  });
}
