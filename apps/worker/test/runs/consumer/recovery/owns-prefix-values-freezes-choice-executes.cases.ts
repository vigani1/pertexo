import { validateWorkflowGraph } from '@pertexo/workflow-model';
import { createHash, randomUUID } from 'node:crypto';
import {
  initialCheckpointFactory,
  recoveryPreparation,
} from '@pertexo/core/execution';
import {
  createWorkflowRunDatabase,
  WorkflowRecoveryUnavailableError,
  IdempotencyRequestConflictError,
  WorkflowRunNotFoundError,
  WorkspaceRunQuotaExceededError,
} from '@pertexo/core/runs';
import { createOutboxDispatcherDatabase } from '@pertexo/core/testing';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import { createPlatformNodeRegistry } from '@pertexo/node-catalog/server';

import { createQueueProducer, JOB_NAME } from '@pertexo/queue';
import { composeExecutableCatalog } from '@pertexo/workflow-engine';

import { expect, it } from 'vitest';
import { createCoordinatorRuntime } from '../../../../dist/runs/runtime.js';
import { WorkerDrainState } from '../../../../dist/runtime/shutdown/drain-state.js';
import { OutboxDispatcher } from '../../../../dist/transport/outbox/dispatch/runtime.js';
import { coordinatorFixture as fixture } from '../../../support/coordinator/consumer.js';
import { insertCompiledWorkflow } from '../../../support/coordinator/workflows.js';
import { graph, closeOwned } from './fixture.js';
import { createScriptedRecoveryRegistry } from './execution/registry.js';
import { assertDispatchedRecovery } from './execution/effects.js';
import { testNodeAttemptRuntime } from '../../../support/runtime-factories.js';

export function registerOwnsPrefixValuesFreezesChoiceExecutes(): void {
  it('owns prefix values, freezes the choice, executes only the suffix and deduplicates after source retirement', async () => {
    const workflowId = randomUUID(),
      workflowVersionId = randomUUID();
    expect(validateWorkflowGraph(graph()).issues).toEqual([]);
    await insertCompiledWorkflow(fixture.ownerQuery, {
      actorId: fixture.actorId,
      workspaceId: fixture.workspaceId,
      identity: { workflowId, workflowVersionId },
      graph: graph(),
      name: 'Recovery proof',
      catalog: PLATFORM_NODE_CATALOG,
    });
    await fixture.ownerQuery(
      'update app.workflows set published_version_id=$2 where id=$1',
      [workflowId, workflowVersionId],
    );
    const config = (url: string, max: number) =>
      parseDatabaseConfig({
        connectionString: fixture.databaseUrl(url),
        max,
      });
    const runs = createWorkflowRunDatabase(config(fixture.apiUrl, 4));
    const catalog = composeExecutableCatalog(PLATFORM_NODE_CATALOG);
    const prepareRecovery = recoveryPreparation({ catalog });
    const registry = createPlatformNodeRegistry();
    const executed: { runId: string; nodeId: string }[] = [];
    const owners: (() => Promise<void>)[] = [() => runs.close()];
    let primary: { error: unknown } | undefined;
    try {
      const coordinator = await createCoordinatorRuntime({
        maintenanceDatabase: config(fixture.dispatcherUrl, 2),
        database: config(fixture.workerUrl, 6),
        maximumAdmissions: 10,
        redisUrl: fixture.redisUrl,
      });
      owners.push(() => coordinator.close());
      const attempts = await testNodeAttemptRuntime(
        {
          database: config(fixture.workerUrl, 6),
          heartbeatIntervalMillis: 1_000,
          leaseDurationSeconds: 10,
          redisUrl: fixture.redisUrl,
          workerId: `recovery-${randomUUID()}`,
        },
        {
          registry: createScriptedRecoveryRegistry({ registry, executed }),
        },
      );
      owners.push(() => attempts.close());
      const store = createOutboxDispatcherDatabase(
        config(fixture.dispatcherUrl, 2),
      );
      owners.push(() => store.close());
      const producer = createQueueProducer({ redisUrl: fixture.redisUrl });
      owners.push(() => producer.close());
      const dispatcher = new OutboxDispatcher(store, producer, {
        drainState: new WorkerDrainState(),
        options: {
          batchSize: 10,
          jobNames: [JOB_NAME.advanceWorkflowRun, JOB_NAME.executeNodeAttempt],
          leaseDurationMillis: 30_000,
          leaseOwner: `recovery-${randomUUID()}`,
          retryDelayMillis: 1_000,
          pollIntervalMillis: 250,
        },
      });
      owners.splice(-2, 2, () => dispatcher.close());
      await Promise.all([
        coordinator.consumer.waitUntilReady(5_000),
        attempts.consumer.waitUntilReady(5_000),
        producer.waitUntilReady(5_000),
      ]);
      dispatcher.start();
      const key = createHash('sha256').update(randomUUID()).digest('hex');
      await fixture.ownerQuery(
        `with revision as (insert into app.workspace_variable_set_revisions(workspace_id,revision,values_json) values($1,1,'{"NAME":"original"}') returning workspace_id,revision) insert into app.workspace_variables(workspace_id,revision) select workspace_id,revision from revision`,
        [fixture.workspaceId],
      );
      const source = await runs.start({
        actorId: fixture.actorId,
        workspaceId: fixture.workspaceId,
        workflowId,
        idempotencyKeyHash: key,
        requestHash: key,
        scope: `workflow:${workflowId}:manual`,
        input: { name: 'original' },
        checkpointFactory: initialCheckpointFactory({ catalog }),
      });
      await fixture.waitFor(
        () =>
          fixture.workerQuery<{ status: string }>(
            'select status from app.workflow_runs where id=$1',
            [source.run.id],
          ),
        (rows) => rows[0]?.status === 'failed',
        30_000,
      );
      await fixture.ownerQuery(
        `with revision as (insert into app.workspace_variable_set_revisions(workspace_id,revision,values_json) values($1,2,'{"NAME":"changed"}') returning workspace_id,revision) update app.workspace_variables head set revision=revision.revision from revision where head.workspace_id=revision.workspace_id`,
        [fixture.workspaceId],
      );
      const before = await runs.get({
        actorId: fixture.actorId,
        workspaceId: fixture.workspaceId,
        runId: source.run.id,
      });
      const preview = await runs.recovery({
        actorId: fixture.actorId,
        workspaceId: fixture.workspaceId,
        runId: source.run.id,
        prepareRecovery,
      });
      expect(preview).toMatchObject({
        kind: 'eligible',
        nodeId: 'target',
        reusedCount: 3,
        effectRisk: 'ordinary',
      });
      if (preview.kind !== 'eligible') throw new Error('Source should qualify');
      const command = {
        actorId: fixture.actorId,
        workspaceId: fixture.workspaceId,
        sourceRunId: source.run.id,
        workflowVersionId,
        nodeRunId: preview.nodeRunId,
        idempotencyKeyHash: createHash('sha256')
          .update(randomUUID())
          .digest('hex'),
        requestHash: key,
        scope: `workflow:${source.run.id}:recover`,
        prepareRecovery,
      };
      await expect(
        runs.recover({ ...command, nodeRunId: randomUUID() }),
      ).rejects.toBeInstanceOf(WorkflowRecoveryUnavailableError);
      const entitlement = (
        await fixture.ownerQuery<{
          version: number;
          queued_run_limit: number;
        }>(
          'select version,queued_run_limit from app.workspace_execution_entitlement_versions where workspace_id=$1 and version=(select current_version from app.workspace_execution_entitlements where workspace_id=$1)',
          [fixture.workspaceId],
        )
      )[0];
      if (entitlement === undefined)
        throw new Error('Missing fixture entitlement');
      const blocker = randomUUID();
      await fixture.ownerQuery(
        'update app.workspace_execution_entitlement_versions set queued_run_limit=1 where workspace_id=$1 and version=$2',
        [fixture.workspaceId, entitlement.version],
      );
      await fixture.workerQuery(
        "insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status) values($1,$2,$3,$4,'api','queued')",
        [blocker, fixture.workspaceId, workflowId, workflowVersionId],
      );
      await expect(runs.recover(command)).rejects.toBeInstanceOf(
        WorkspaceRunQuotaExceededError,
      );
      expect(
        (
          await fixture.workerQuery<{ count: number }>(
            'select count(*)::int count from app.idempotency_records where scope=$1',
            [command.scope],
          )
        )[0]?.count,
      ).toBe(0);
      await fixture.ownerQuery('delete from app.workflow_runs where id=$1', [
        blocker,
      ]);
      await fixture.ownerQuery(
        'update app.workspace_execution_entitlement_versions set queued_run_limit=$3 where workspace_id=$1 and version=$2',
        [
          fixture.workspaceId,
          entitlement.version,
          entitlement.queued_run_limit,
        ],
      );
      const [first, second] = await Promise.all([
        runs.recover(command),
        runs.recover(command),
      ]);
      expect(first.run.id).toBe(second.run.id);
      expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
      const accepted = first.run.id;
      expect(
        await runs.readVariables({
          actorId: fixture.actorId,
          workspaceId: fixture.workspaceId,
          runId: accepted,
        }),
      ).toEqual({ revision: 1, values: { NAME: 'original' } });
      await fixture.waitFor(
        () =>
          fixture.workerQuery<{ status: string }>(
            'select status from app.workflow_runs where id=$1',
            [accepted],
          ),
        (rows) => rows[0]?.status === 'succeeded',
        30_000,
      );
      expect(
        executed.filter((x) => x.runId === accepted).map((x) => x.nodeId),
      ).toEqual(['target', 'stop']);
      expect(
        await runs.get({
          actorId: fixture.actorId,
          workspaceId: fixture.workspaceId,
          runId: source.run.id,
        }),
      ).toEqual(before);
      const resultRows = await fixture.workerQuery<{ output_ref: unknown }>(
        'select output_ref from app.workflow_runs where id=$1',
        [accepted],
      );
      expect(resultRows).toEqual([
        { output_ref: { kind: 'inline', value: 'original' } },
      ]);
      const recovered = await runs.get({
        actorId: fixture.actorId,
        workspaceId: fixture.workspaceId,
        runId: accepted,
      });
      expect(recovered?.run.recovery).toMatchObject({
        targetNodeRunId: preview.nodeRunId,
        reusedCount: 3,
        effectRisk: 'ordinary',
        effectsAcknowledged: false,
      });
      const health = await runs.stepHealth({
        actorId: fixture.actorId,
        workspaceId: fixture.workspaceId,
        workflowId,
      });
      expect(health?.items.find((step) => step.nodeId === 'prefix')?.runs).toBe(
        1,
      );
      expect(health?.items.find((step) => step.nodeId === 'target')?.runs).toBe(
        2,
      );
      expect(
        await runs.stepRuns({
          actorId: fixture.actorId,
          workspaceId: fixture.workspaceId,
          workflowId,
          nodeId: 'prefix',
          limit: 10,
        }),
      ).toHaveLength(1);
      const copies =
        recovered?.nodes.filter((x) => x.reused !== undefined) ?? [];
      expect(copies).toHaveLength(3);
      for (const copy of copies) {
        expect(copy.currentAttemptNumber).toBe(0);
        expect(copy.startedAt).toBeNull();
        expect(copy.completedAt).toBeNull();
        expect(copy.reused?.sourceRunId).toBe(source.run.id);
      }
      const rows = await fixture.workerQuery<{ count: number }>(
        'select count(*)::int count from app.node_attempts where node_run_id=any($1::uuid[])',
        [copies.map((x) => x.id)],
      );
      expect(rows[0]?.count).toBe(0);
      const events = await fixture.workerQuery<{
        type: string;
        sequence: number;
      }>(
        'select type,sequence from app.run_events where workflow_run_id=$1 order by sequence',
        [accepted],
      );
      expect(events.slice(0, 4).map((x) => x.type)).toEqual([
        'run.queued',
        'node.reused',
        'node.reused',
        'node.reused',
      ]);
      expect(new Set(events.map((x) => x.sequence)).size).toBe(events.length);
      await expect(
        runs.recover({ ...command, requestHash: 'a'.repeat(64) }),
      ).rejects.toBeInstanceOf(IdempotencyRequestConflictError);
      await expect(
        runs.recovery({
          actorId: fixture.actorId,
          workspaceId: randomUUID(),
          runId: source.run.id,
          prepareRecovery,
        }),
      ).rejects.toBeInstanceOf(WorkflowRunNotFoundError);
      await assertDispatchedRecovery({
        runs,
        catalog,
        prepareRecovery,
        command,
      });
      await fixture.ownerQuery(
        'delete from app.node_runs where workflow_run_id=$1',
        [source.run.id],
      );
      await fixture.ownerQuery(
        'delete from app.run_checkpoints where workflow_run_id=$1',
        [source.run.id],
      );
      expect(
        await runs.recovery({
          actorId: fixture.actorId,
          workspaceId: fixture.workspaceId,
          runId: source.run.id,
          prepareRecovery,
        }),
      ).toMatchObject({ kind: 'refused', reason: 'values_expired' });
      expect(await runs.recover(command)).toMatchObject({
        run: { id: accepted },
        replayed: true,
      });
      expect(
        await runs.readNodeRunOutput({
          actorId: fixture.actorId,
          workspaceId: fixture.workspaceId,
          runId: accepted,
          nodeRunId: copies.find((x) => x.nodeId === 'prefix')?.id ?? '',
        }),
      ).toEqual({ kind: 'inline', value: { name: 'original' } });
      expect(
        await fixture.workerQuery<{ count: number }>(
          "select count(*)::int count from app.audit_events where action='workflow.run.recovered' and target_id=$1",
          [accepted],
        ),
      ).toEqual([{ count: 1 }]);
    } catch (error) {
      primary = { error };
      throw error;
    } finally {
      await closeOwned(owners, primary);
    }
  }, 60_000);
}
