import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type {
  DatabaseRuntime,
  DatabaseConfig,
} from '@pertexo/database/platform';
import { acquireDatabasePool } from '@pertexo/database/platform';
import {
  rethrowQueryFailure,
  withTenantScopedClient,
} from '@pertexo/database/primitives';
import { triggerSchedules } from '@pertexo/database/schema';

import { ScheduleTriggerError } from './errors.js';

import { canManageWorkflowTrigger } from '../management.queries.js';
import { refreshWorkflowActivation } from '../reconciliation/health.repository.js';
import type { ScheduleTriggerStore } from './management/contract.js';
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
} from './management/state.queries.js';
import {
  authorizeScheduleReader,
  createScheduleTriggerReads,
} from './reads.queries.js';
export function createScheduleTriggerStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): ScheduleTriggerStore {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
  return Object.freeze({
    ...createScheduleTriggerReads(pool),
    list: (input: Parameters<ScheduleTriggerStore['list']>[0]) =>
      withTenantScopedClient(
        pool,
        {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
        },
        async (client) => {
          const workflowId = input.workflowId;
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
      input: Parameters<ScheduleTriggerStore['setEnabled']>[0],
    ) =>
      withTenantScopedClient(
        pool,
        {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
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
