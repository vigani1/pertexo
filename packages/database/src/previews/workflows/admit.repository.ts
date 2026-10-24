import { bindResourcePredicate } from '../../tenant-access/resources/query-scope.js';
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
  const active = await client.query(
    `select id from app.workflow_runs where workspace_id=$1 and workflow_id=$2 and started_by=$3 and ${bindResourcePredicate(testRunSql().inlineParams(), [])} and status in ('queued','running','waiting') limit 1`,
    [input.workspaceId, input.workflowId, input.actorId],
  );
  if (active.rowCount !== 0) throw new WorkflowTestError('already_running');
}
export async function requireNoActiveSuite(
  client: PoolClient,
  input: SampleScope,
): Promise<void> {
  const active = await client.query(
    "select id from app.workflow_test_suites where workspace_id=$1 and workflow_id=$2 and started_by=$3 and status='running' limit 1",
    [input.workspaceId, input.workflowId, input.actorId],
  );
  if (active.rowCount !== 0) throw new WorkflowTestError('already_running');
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
