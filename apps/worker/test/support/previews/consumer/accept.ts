import { createHash } from 'node:crypto';
import { acceptManualFixtureRun } from '../../attempts/manual-start.js';
import { drizzle } from 'drizzle-orm/node-postgres';

import {
  acceptPreviewRun,
  parseWorkspaceId,
  withTenantScopedClient,
  type AcceptWorkflowRunInput,
  type AcceptPreviewRunInput,
} from '@pertexo/core/testing';
import { databaseSchema } from '@pertexo/database/testing';

import { createCheckpoint } from '@pertexo/workflow-engine';

import {
  workspaceId,
  actorUserId,
  workflowId,
  workflowVersionId,
} from './environment.js';
import { apiPool, withOwner } from './lifecycle.js';
import type { AcceptedDelivery, AcceptedWorkflowDelivery } from './contract.js';

let acceptanceSequence = 0;

export function acceptanceInput(
  traceparent: string,
  overrides: Partial<AcceptPreviewRunInput> = {},
): AcceptPreviewRunInput {
  acceptanceSequence += 1;
  return {
    actorUserId,
    definitionKey: 'core.set',
    definitionVersion: 1,
    draftFingerprint: 'b'.repeat(64),
    draftRevision: 3,
    dryRun: 'not_supported',
    executableNode: {
      config: {},
      configVersion: 1,
      definition: { key: 'core.set', version: 1 },
      id: 'node-1',
      inputMappings: {
        hello: { kind: 'run_input', path: '$.hello' },
      },
      connectionRefs: {},
    },
    executorKey: 'core.set',
    executorVersion: 1,
    executionDeadlineAt: new Date(Date.now() + 5 * 60 * 1_000),
    expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
    input: { kind: 'manual' as const, value: { hello: 'transport' } },
    keyHash: createHash('sha256')
      .update(`transport-key-${String(acceptanceSequence)}`)
      .digest('hex'),
    mayContactProvider: false,
    mayCauseExternalSideEffect: false,
    nodeId: 'node-1',
    operation: 'preview.execute',
    requestHash: createHash('sha256')
      .update(`transport-request-${String(acceptanceSequence)}`)
      .digest('hex'),
    scope: `workflow:${workflowId}:node-1`,
    sideEffectClass: 'safe',
    traceparent,
    workflowId,
    ...overrides,
  };
}

export async function acceptDelivery(
  traceparent: string,
  overrides: Partial<AcceptPreviewRunInput> = {},
): Promise<AcceptedDelivery> {
  const input = acceptanceInput(traceparent, overrides);
  const accepted = await withTenantAccept(input);
  return {
    accepted,
    job: {
      data: {
        outboxEventId: accepted.outboxEventId,
        previewAttemptId: accepted.previewAttemptId,
        previewRunId: accepted.previewRunId,
        traceparent,
        workspaceId,
      },
      name: 'execute-preview-attempt',
    },
  };
}

export async function withTenantAccept(input: AcceptPreviewRunInput) {
  const accepted = await withTenantScopedClient(
    apiPool,
    { workspaceId },
    async (client) =>
      acceptPreviewRun(
        {
          db: drizzle(client, { schema: databaseSchema }),
          workspaceId: parseWorkspaceId(workspaceId),
        },
        input,
      ),
  );
  if (accepted.outboxEventId === null || accepted.previewAttemptId === null)
    throw new Error('Consumer fixture requires a dispatched preview');
  return {
    ...accepted,
    outboxEventId: accepted.outboxEventId,
    previewAttemptId: accepted.previewAttemptId,
  };
}

let workflowAcceptanceSequence = 0;

export async function acceptWorkflowDelivery(
  traceparent: string,
  runInput: unknown,
): Promise<AcceptedWorkflowDelivery> {
  await withOwner(async (client) => {
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    await client.query(
      `update app.workflows set published_version_id=$1,activation_status='active' where workspace_id=$2 and id=$3`,
      [workflowVersionId, workspaceId, workflowId],
    );
  });
  workflowAcceptanceSequence += 1;
  const keyHash = createHash('sha256')
    .update(`validate-workflow-key-${String(workflowAcceptanceSequence)}`)
    .digest('hex');
  const requestHash = createHash('sha256')
    .update(`validate-workflow-request-${String(workflowAcceptanceSequence)}`)
    .digest('hex');
  const acceptance: AcceptWorkflowRunInput = {
    initialCheckpoint: createCheckpoint({
      workflowVersionId,
      iterationBudget: 0,
    }),
    keyHash,
    operation: 'workflow.run.accept',
    requestHash,
    runInput,
    scope: `workflow:${workflowId}:manual`,
    traceparent,
    triggerType: 'manual',
    workflowId,
    workflowVersionId,
  };
  const accepted = await withTenantScopedClient(
    apiPool,
    { workspaceId },
    (client) =>
      acceptManualFixtureRun(
        {
          db: drizzle(client, { schema: databaseSchema }),
          workspaceId: parseWorkspaceId(workspaceId),
        },
        acceptance,
      ),
  );
  return {
    accepted,
    job: {
      data: {
        outboxEventId: accepted.outboxEventId,
        runId: accepted.runId,
        traceparent,
        workspaceId,
      },
      name: 'advance-workflow-run',
    },
  };
}
