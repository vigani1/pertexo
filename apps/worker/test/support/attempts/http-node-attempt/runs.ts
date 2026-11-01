import { createHash, randomUUID } from 'node:crypto';
import { acceptManualFixtureRun } from '../manual-start.js';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { requestWorkflowRunCancellation } from '@pertexo/core/testing';
import { createOperatorCommandStore } from '@pertexo/core/runs';

import {
  buildWorkflowExecutable,
  createCheckpoint,
} from '@pertexo/workflow-engine';

import {
  operatorUrl,
  workspaceId,
  actorId,
  workflowId,
  workflowVersionId,
  activeCatalog,
  databaseUrl,
} from './environment.js';
import { type ProviderScenario, providerScenarioGraph } from './graphs.js';
import { apiDatabase, withOwner } from './lifecycle.js';

export async function acceptRun() {
  return apiDatabase.withWorkspace(workspaceId, (transaction) =>
    acceptManualFixtureRun(transaction, {
      initialCheckpoint: createCheckpoint({
        workflowVersionId,
        iterationBudget: 0,
        nextEventSequence: 2,
      }),
      keyHash: createHash('sha256').update(randomUUID()).digest('hex'),
      operation: 'workflow.run.accept',
      requestHash: createHash('sha256').update(randomUUID()).digest('hex'),
      runInput: {},
      scope: `workflow:${workflowId}:manual`,
      triggerType: 'manual',
      workflowId,
      workflowVersionId,
    }),
  );
}

export async function acceptProviderScenarioRun(provider: ProviderScenario) {
  const scenarioWorkflowId = randomUUID();
  const scenarioWorkflowVersionId = randomUUID();
  const scenarioGraph = providerScenarioGraph(provider);
  const executable = buildWorkflowExecutable({
    graph: scenarioGraph,
    catalog: activeCatalog,
  });
  await withOwner(async (client) => {
    await client.query(
      `insert into app.workflows (id,workspace_id,name,created_by)
       values ($1,$2,$3,$4)`,
      [
        scenarioWorkflowId,
        workspaceId,
        `Provider ${provider} scenario`,
        actorId,
      ],
    );
    await client.query(
      `insert into app.workflow_versions (
         id,workspace_id,workflow_id,version_number,graph_json,
         checksum,executable_json,
         published_by
       ) values ($1,$2,$3,1,$4::jsonb,$5,$6::jsonb,$7)`,
      [
        scenarioWorkflowVersionId,
        workspaceId,
        scenarioWorkflowId,
        JSON.stringify(scenarioGraph),
        executable.checksum,
        JSON.stringify(executable.envelope),
        actorId,
      ],
    );
  });
  const accepted = await apiDatabase.withWorkspace(workspaceId, (transaction) =>
    acceptManualFixtureRun(transaction, {
      initialCheckpoint: createCheckpoint({
        workflowVersionId: scenarioWorkflowVersionId,
        iterationBudget: 0,
        nextEventSequence: 2,
      }),
      keyHash: createHash('sha256').update(randomUUID()).digest('hex'),
      operation: 'workflow.run.accept',
      requestHash: createHash('sha256').update(randomUUID()).digest('hex'),
      runInput: {},
      scope: `workflow:${scenarioWorkflowId}:manual`,
      triggerType: 'manual',
      workflowId: scenarioWorkflowId,
      workflowVersionId: scenarioWorkflowVersionId,
    }),
  );
  return Object.freeze({
    ...accepted,
    workflowId: scenarioWorkflowId,
    workflowVersionId: scenarioWorkflowVersionId,
  });
}

export async function cancelProviderScenarioRun(runId: string): Promise<void> {
  await apiDatabase.withWorkspace(workspaceId, (transaction) =>
    requestWorkflowRunCancellation(transaction, {
      actor: 'http-attempt-integration',
      reason: 'Exercise durable cancellation in the composed worker proof',
      runId,
    }),
  );
}

export async function expireProviderScenarioRun(runId: string): Promise<void> {
  await withOwner((client) =>
    client.query(
      `update app.workflow_runs
          set deadline_at=clock_timestamp(),updated_at=clock_timestamp()
        where workspace_id=$1 and id=$2`,
      [workspaceId, runId],
    ),
  );
}

export async function reclaimProviderScenarioAttempt(input: {
  attemptId: string;
  expectedFence: number;
}) {
  const operator = createOperatorCommandStore(
    parseDatabaseConfig({ connectionString: databaseUrl(operatorUrl), max: 1 }),
  );
  try {
    return await operator.reconcileAttempt({
      action: 'reclaim',
      actorRef: 'http-attempt-operator',
      attemptId: input.attemptId,
      commandId: randomUUID(),
      dryRun: false,
      expectedFenceToken: input.expectedFence,
      reason: 'Recover an expired keyed provider attempt in the composed proof',
      workspaceId,
    });
  } finally {
    await operator.close();
  }
}
