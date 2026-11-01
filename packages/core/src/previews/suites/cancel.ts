import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import {
  parseWorkspaceId,
  rethrowQueryFailure,
} from '@pertexo/database/primitives';
import {
  databaseSchema,
  workflowTestSuiteCases,
  workflowTestSuites,
} from '@pertexo/database/schema';
import type { Role } from '@pertexo/workflow-model';
import { cancelInTransaction } from '../../runs/commands/cancel-active.repository.js';
import { WorkflowRunNotFoundError } from '../../runs/errors.js';
import { requireTestCapability } from '../workflows/access.js';
import { WorkflowTestError } from '../workflows/errors.js';
import { skipPendingCases } from './cases.queries.js';
import type { WorkflowTestSuiteInput } from './contract.js';

export async function cancelTestSuite(
  client: PoolClient,
  role: Role,
  input: WorkflowTestSuiteInput,
): Promise<void> {
  requireTestCapability(role, 'run:cancel');
  const db = drizzle(client);
  const found = await db
    .select()
    .from(workflowTestSuites)
    .where(
      and(
        eq(workflowTestSuites.workspaceId, input.workspaceId),
        eq(workflowTestSuites.workflowId, input.workflowId),
        eq(workflowTestSuites.id, input.suiteId),
        sql`${workflowTestSuites.expiresAt}>clock_timestamp()`,
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  const suite = found[0];
  if (suite === undefined) throw new WorkflowTestError('not_found');
  if (suite.status !== 'running') return;
  await db
    .update(workflowTestSuites)
    .set({
      cancelRequested: true,
      stopReason: 'user_canceled',
      nextCheckAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(workflowTestSuites.workspaceId, input.workspaceId),
        eq(workflowTestSuites.id, input.suiteId),
      ),
    )
    .catch(rethrowQueryFailure);
  await skipPendingCases(client, input.workspaceId, input.suiteId);
  const active = await db
    .select({ runId: workflowTestSuiteCases.runId })
    .from(workflowTestSuiteCases)
    .where(
      and(
        eq(workflowTestSuiteCases.workspaceId, input.workspaceId),
        eq(workflowTestSuiteCases.suiteId, input.suiteId),
        eq(workflowTestSuiteCases.status, 'running'),
      ),
    )
    .catch(rethrowQueryFailure);
  const runId = active[0]?.runId;
  if (runId === undefined)
    await db
      .update(workflowTestSuites)
      .set({ status: 'canceled', completedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(workflowTestSuites.workspaceId, input.workspaceId),
          eq(workflowTestSuites.id, input.suiteId),
        ),
      )
      .catch(rethrowQueryFailure);
  else if (runId === null) throw new WorkflowRunNotFoundError();
  else
    await cancelInTransaction(
      {
        db: drizzle(client, { schema: databaseSchema }),
        workspaceId: parseWorkspaceId(input.workspaceId),
      },
      {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        runId,
      },
    );
}
