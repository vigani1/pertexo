import { createHash, randomUUID } from 'node:crypto';
import type { recoveryPreparation } from '@pertexo/core/execution';
import { initialCheckpointFactory } from '@pertexo/core/execution';
import type { createWorkflowRunDatabase } from '@pertexo/core/runs';
import { IdempotencyRequestConflictError } from '@pertexo/core/runs';

import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';

import type { composeExecutableCatalog } from '@pertexo/workflow-engine';
import type { WorkflowGraph } from '@pertexo/workflow-model';
import { expect } from 'vitest';

import { coordinatorFixture as fixture } from '../../../../support/coordinator/consumer.js';
import { insertCompiledWorkflow } from '../../../../support/coordinator/workflows.js';
import { graph } from '../fixture.js';

export async function assertDispatchedRecovery(
  input: Readonly<{
    runs: ReturnType<typeof createWorkflowRunDatabase>;
    catalog: ReturnType<typeof composeExecutableCatalog>;
    prepareRecovery: ReturnType<typeof recoveryPreparation>;
    command: Parameters<
      ReturnType<typeof createWorkflowRunDatabase>['recover']
    >[0];
  }>,
) {
  const { runs, catalog, prepareRecovery, command } = input;
  // The executor is scripted at the registry boundary; no external service is contacted.
  for (const unknown of [false, true]) {
    const httpId = unknown ? 'unknown-http' : 'http';
    const identity = {
      workflowId: randomUUID(),
      workflowVersionId: randomUUID(),
    };
    const original = graph();
    const manual = original.nodes.find((n) => n.id === 'manual');
    const stop = original.nodes.find((n) => n.id === 'stop');
    if (manual === undefined || stop === undefined)
      throw new Error('Missing fixture nodes');
    const httpGraph: WorkflowGraph = {
      settings: original.settings,
      nodes: [
        manual,
        {
          ...manual,
          id: httpId,
          definition: { key: 'http.request', version: 1 },
          config: {
            method: 'POST',
            url: 'https://example.test/action',
            headers: {},
            timeoutMillis: 1000,
            maxRedirects: 0,
            maxResponseBytes: 1024,
            inlineResponseBytes: 1024,
          },
          connectionRefs: { http_headers: randomUUID() },
        },
        stop,
      ],
      edges: [
        {
          id: 'to-http',
          source: { nodeId: 'manual', port: 'out' },
          target: { nodeId: httpId, port: 'in' },
        },
        {
          id: 'to-stop',
          source: { nodeId: httpId, port: 'out' },
          target: { nodeId: 'stop', port: 'in' },
        },
      ],
    };
    await insertCompiledWorkflow(fixture.ownerQuery, {
      actorId: fixture.actorId,
      workspaceId: fixture.workspaceId,
      identity,
      graph: httpGraph,
      name: 'Dispatched recovery proof',
      catalog: PLATFORM_NODE_CATALOG,
    });
    await fixture.ownerQuery(
      'update app.workflows set published_version_id=$2 where id=$1',
      [identity.workflowId, identity.workflowVersionId],
    );
    const httpKey = createHash('sha256').update(randomUUID()).digest('hex');
    const started = await runs.start({
      actorId: fixture.actorId,
      workspaceId: fixture.workspaceId,
      workflowId: identity.workflowId,
      idempotencyKeyHash: httpKey,
      requestHash: httpKey,
      scope: `workflow:${identity.workflowId}:manual`,
      input: {},
      checkpointFactory: initialCheckpointFactory({ catalog }),
    });
    await fixture.waitFor(
      () =>
        fixture.workerQuery<{ status: string }>(
          'select status from app.workflow_runs where id=$1',
          [started.run.id],
        ),
      (rows) => rows[0]?.status === (unknown ? 'outcome_unknown' : 'failed'),
      30_000,
    );
    const httpPreview = await runs.recovery({
      actorId: fixture.actorId,
      workspaceId: fixture.workspaceId,
      runId: started.run.id,
      prepareRecovery,
    });
    expect(httpPreview).toMatchObject({
      kind: 'eligible',
      effectRisk: unknown ? 'unknown_outcome' : 'possible_effects',
      reusedCount: 1,
    });
    if (httpPreview.kind !== 'eligible')
      throw new Error('Definite dispatched failure must qualify');
    const httpCommand = {
      ...command,
      sourceRunId: started.run.id,
      workflowVersionId: identity.workflowVersionId,
      nodeRunId: httpPreview.nodeRunId,
      scope: `workflow:${started.run.id}:recover`,
      idempotencyKeyHash: httpKey,
      requestHash: httpKey,
    };
    await expect(runs.recover(httpCommand)).rejects.toMatchObject({
      reason: unknown
        ? 'unknown_outcome_acknowledgement_required'
        : 'effects_acknowledgement_required',
    });
    if (unknown)
      await expect(
        runs.recover({
          ...httpCommand,
          acknowledgePossibleEffects: true,
        }),
      ).rejects.toMatchObject({
        reason: 'unknown_outcome_acknowledgement_required',
      });
    expect(
      await fixture.workerQuery<{ count: number }>(
        'select count(*)::int count from app.idempotency_records where scope=$1',
        [httpCommand.scope],
      ),
    ).toEqual([{ count: 0 }]);
    const acknowledged = {
      ...httpCommand,
      ...(unknown
        ? { acknowledgeUnknownOutcome: true as const }
        : { acknowledgePossibleEffects: true as const }),
      requestHash: createHash('sha256')
        .update(`${httpKey}:acknowledged`)
        .digest('hex'),
    };
    const retried = await runs.recover(acknowledged);
    await fixture.waitFor(
      () =>
        fixture.workerQuery<{ status: string }>(
          'select status from app.workflow_runs where id=$1',
          [retried.run.id],
        ),
      (rows) => rows[0]?.status === 'succeeded',
      30_000,
    );
    expect(
      (
        await runs.get({
          actorId: fixture.actorId,
          workspaceId: fixture.workspaceId,
          runId: retried.run.id,
        })
      )?.run.recovery,
    ).toMatchObject({
      effectRisk: unknown ? 'unknown_outcome' : 'possible_effects',
      effectsAcknowledged: true,
    });
    const auditRows = await fixture.workerQuery<{
      metadata: Record<string, unknown>;
    }>(
      "select metadata from app.audit_events where action='workflow.run.recovered' and target_id=$1",
      [retried.run.id],
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.metadata).toMatchObject({
      sourceRunId: started.run.id,
      targetNodeRunId: httpPreview.nodeRunId,
      effectRisk: unknown ? 'unknown_outcome' : 'possible_effects',
      acknowledgePossibleEffects: !unknown,
      acknowledgeUnknownOutcome: unknown,
    });
    expect(await runs.recover(acknowledged)).toMatchObject({
      run: { id: retried.run.id },
      replayed: true,
    });
    await expect(runs.recover(httpCommand)).rejects.toBeInstanceOf(
      IdempotencyRequestConflictError,
    );
  }
}
