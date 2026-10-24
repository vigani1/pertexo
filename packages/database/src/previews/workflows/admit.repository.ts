import { and, eq, inArray, sql } from 'drizzle-orm';
import { workflowRuns } from '../../schema/runs/execution.js';
import { workflowTestSuites } from '../../schema/runs/suites.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { canonicalJson } from '@pertexo/workflow-model';
import { databaseSchema } from '../../schema.js';
import { parseWorkspaceId } from '../../tenant-access/transactions.js';
import {
  acceptWorkflowRun,
  prepareWorkflowRunAcceptance,
} from '../../runs/commands/acceptance.js';
import { WorkflowTestError } from './contract.js';
import { testRunSql } from '../../runs/data-policy.js';
import type { SampleScope } from '../../authoring/step-samples/contract.js';

export async function requireNoActiveTest(
  client: PoolClient,
  input: SampleScope,
): Promise<void> {
  const active = await drizzle(client)
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workspaceId, input.workspaceId),
        eq(workflowRuns.workflowId, input.workflowId),
        eq(workflowRuns.startedBy, input.actorId),
        testRunSql(),
        inArray(workflowRuns.status, ['queued', 'running', 'waiting']),
      ),
    )
    .limit(1)
    .catch(rethrowQueryFailure);
  if (active.length !== 0) throw new WorkflowTestError('already_running');
}
export async function requireNoActiveSuite(
  client: PoolClient,
  input: SampleScope,
): Promise<void> {
  const active = await drizzle(client)
    .select({ id: workflowTestSuites.id })
    .from(workflowTestSuites)
    .where(
      and(
        eq(workflowTestSuites.workspaceId, input.workspaceId),
        eq(workflowTestSuites.workflowId, input.workflowId),
        eq(workflowTestSuites.startedBy, input.actorId),
        eq(workflowTestSuites.status, 'running'),
      ),
    )
    .limit(1)
    .catch(rethrowQueryFailure);
  if (active.length !== 0) throw new WorkflowTestError('already_running');
}
/** Every suite case is an ordinary draft test, with one acceptance/outbox owner. */
export async function admitTestRun(
  client: PoolClient,
  input: SampleScope &
    Readonly<{
      runId: string;
      snapshotId: string;
      input: unknown;
      initialCheckpoint: unknown;
      deadlineAt: Date;
      command: Readonly<{ scope: string; key: string; request: unknown }>;
      variableSetRevision?: number | null;
    }>,
) {
  const transaction = {
    db: drizzle(client, { schema: databaseSchema }),
    workspaceId: parseWorkspaceId(input.workspaceId),
  };
  const preparation = await prepareWorkflowRunAcceptance(
    transaction,
    input.workflowId,
  );
  const digest = (text: string) =>
    createHash('sha256').update(text).digest('hex');
  return acceptWorkflowRun(
    transaction,
    {
      operation: 'workflow.run.accept',
      scope: input.command.scope,
      keyHash: digest(input.command.key),
      requestHash: digest(canonicalJson(input.command.request)),
      workflowId: input.workflowId,
      workflowVersionId: input.snapshotId,
      startedBy: input.actorId,
      triggerType: 'test',
      runInput: input.input,
      initialCheckpoint: input.initialCheckpoint,
      deadlineAt: input.deadlineAt,
    },
    {
      ...preparation,
      runId: input.runId,
      failureNotificationPolicy: undefined,
      ...(input.variableSetRevision === undefined
        ? {}
        : { variableSetRevision: input.variableSetRevision }),
    },
  );
}
