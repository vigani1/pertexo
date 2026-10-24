import { workflowRunValues } from '../../schema/runs/values.js';
import { and, asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { RUN_VALUE_LIMITS, type RunValues } from '@pertexo/node-sdk';
import type { DatabaseConfig } from '../../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../platform/pool/runtime.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { withWorkspaceWriteClient } from '../../attempts/transactions.repository.js';
import {
  lockCapabilityExecution,
  assertCapabilityExecution,
} from '../../attempts/dispatch/fence.repository.js';
import { RunValuesLimitError, type RunValuesStore } from './records.js';

export function createRunValuesStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): RunValuesStore {
  const lease = acquireDatabasePool(config, runtime);
  return {
    close: () => lease.close(),
    save: (input) =>
      withWorkspaceWriteClient(
        lease.pool,
        input.workspaceId,
        input.signal,
        async (client): Promise<RunValues> => {
          await lockCapabilityExecution(client, input);
          await assertCapabilityExecution(client, input);
          const ownerColumn =
            input.previewRunId === undefined
              ? workflowRunValues.workflowRunId
              : workflowRunValues.previewRunId;
          const ownerId = input.previewRunId ?? input.runId;
          const db = drizzle(client);
          const existing = await db
            .select({
              key: workflowRunValues.key,
              value: workflowRunValues.value,
            })
            .from(workflowRunValues)
            .where(
              and(
                eq(workflowRunValues.workspaceId, input.workspaceId),
                eq(ownerColumn, ownerId),
              ),
            )
            .orderBy(asc(workflowRunValues.key))
            .limit(RUN_VALUE_LIMITS.pairs + 1)
            .catch(rethrowQueryFailure);
          const values = new Map(existing.map((row) => [row.key, row.value]));
          const pairs = Object.entries(input.values);
          for (const [key, value] of pairs) values.set(key, value);
          if (values.size > RUN_VALUE_LIMITS.pairs)
            throw new RunValuesLimitError();
          if (pairs.length > 0) {
            await db
              .insert(workflowRunValues)
              .values(
                pairs.map(([key, value]) => ({
                  id: generatePersistedId(),
                  workspaceId: input.workspaceId,
                  workflowRunId:
                    input.previewRunId === undefined ? input.runId : null,
                  previewRunId: input.previewRunId ?? null,
                  key,
                  value,
                })),
              )
              .onConflictDoUpdate({
                target: [
                  workflowRunValues.workspaceId,
                  ownerColumn,
                  workflowRunValues.key,
                ],
                set: {
                  value: sql`excluded.${sql.identifier(workflowRunValues.value.name)}`,
                  updatedAt: sql`clock_timestamp()`,
                },
              })
              .catch(rethrowQueryFailure);
          }
          await assertCapabilityExecution(client, input);
          return Object.freeze(Object.fromEntries(values));
        },
      ),
  };
}
