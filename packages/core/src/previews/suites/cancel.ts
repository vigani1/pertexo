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
import { rolesForCapability } from '@pertexo/workflow-model';
import type { SampleScope } from '../../authoring/step-samples/contract.js';
import { lockWorkflowAuthoringAuthority } from '../../authoring/workflows/authority.js';
import { cancelInTransaction } from '../../runs/commands/cancel-active.repository.js';
import { WorkflowRunNotFoundError } from '../../runs/errors.js';
import { WorkflowTestError } from '../workflows/errors.js';

export async function cancelTestSuite(
  client: PoolClient,
  input: SampleScope & Readonly<{ suiteId: string }>,
): Promise<void> {
  await lockWorkflowAuthoringAuthority(client, input.workspaceId, {
    actorId: input.actorId,
    roles: rolesForCapability('run:cancel'),
  });
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
  await db
    .update(workflowTestSuiteCases)
    .set({ status: 'skipped' })
    .where(
      and(
        eq(workflowTestSuiteCases.workspaceId, input.workspaceId),
        eq(workflowTestSuiteCases.suiteId, input.suiteId),
        eq(workflowTestSuiteCases.status, 'pending'),
      ),
    )
    .catch(rethrowQueryFailure);
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
