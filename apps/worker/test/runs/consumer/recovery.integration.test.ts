import { validateWorkflowGraph } from '@pertexo/workflow-model';
import { createHash, randomUUID } from 'node:crypto';
import {
  initialCheckpointFactory,
  recoveryPreparation,
} from '@pertexo/execution';
import {
  createWorkflowRunDatabase,
  WorkflowRecoveryUnavailableError,
  IdempotencyRequestConflictError,
  WorkflowRunNotFoundError,
  WorkspaceRunQuotaExceededError,
} from '@pertexo/database/runs';
import {
  createOutboxDispatcherDatabase,
  parseDatabaseConfig,
} from '@pertexo/database/testing';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import { createPlatformNodeRegistry } from '@pertexo/node-catalog/server';
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
import { createQueueProducer, JOB_NAME } from '@pertexo/queue';
import { composeExecutableCatalog } from '@pertexo/workflow-engine';
import type { WorkflowGraph, WorkflowNode } from '@pertexo/workflow-model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCoordinatorRuntime } from '../../../dist/runs/runtime.js';
import { createNodeAttemptRuntime } from '../../../dist/attempts/runtime.js';
import { WorkerDrainState } from '../../../dist/runtime/shutdown/drain-state.js';
import { OutboxDispatcher } from '../../../dist/transport/outbox/dispatcher.js';
import { coordinatorFixture as fixture } from '../../support/coordinator/consumer.js';
import { insertCompiledWorkflow } from '../../support/coordinator/workflows.js';

function graph(): WorkflowGraph {
  const node = (id: string, key: string): WorkflowNode => ({
    id,
    definition: { key, version: 1 },
    config: {},
    configVersion: 1,
    position: { x: 0, y: 0 },
    inputMappings: {},
    connectionRefs: {},
  });
  return {
    settings: { maxRunDurationMs: 60_000 },
    callable: {
      input: {
        type: 'object',
        properties: [
          { name: 'name', valueType: { type: 'string' }, required: true },
        ],
      },
      resultType: { type: 'string' },
      result: { kind: 'node_output', nodeId: 'prefix', path: '$.name' },
    },
    nodes: [
      node('manual', 'core.manual'),
      {
        ...node('prefix', 'core.set'),
        inputMappings: { name: { kind: 'workspace_variable', name: 'NAME' } },
      },
      {
        ...node('choice', 'core.condition'),
        inputMappings: { condition: { kind: 'literal', value: true } },
      },
      {
        ...node('target', 'core.set'),
        inputMappings: {
          name: { kind: 'node_output', nodeId: 'prefix', path: '$.name' },
        },
      },
      node('stop', 'core.terminate'),
      node('other', 'core.terminate'),
    ],
    edges: [
      ['manual', 'choice', 'out'],
      ['choice', 'prefix', 'true'],
      ['prefix', 'target', 'out'],
      ['choice', 'other', 'false'],
      ['target', 'stop', 'out'],
    ].map(([source, target, port], i) => ({
      id: `link-${String(i)}`,
      source: { nodeId: source ?? '', port: port ?? '' },
      target: { nodeId: target ?? '', port: 'in' },
    })),
  };
}
async function closeOwned(
  owners: readonly (() => Promise<void>)[],
  primary: { error: unknown } | undefined,
): Promise<void> {
  const errors: unknown[] = [];
  for (const close of [...owners].reverse())
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  if (errors.length > 0)
    throw new AggregateError(
      primary === undefined ? errors : [primary.error, ...errors],
      'Recovery qualification cleanup failed',
    );
}

const qualified = fixture.enabled ? describe : describe.skip;
qualified(
  'atomic recovery through the real outbox, BullMQ and compiled workers',
  () => {
    beforeAll(fixture.setup, 60_000);
    afterAll(fixture.restoreServicesAndClose);
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
      let fail = true;
      let httpFailure = true;
      let unknownHttpFailure = true;
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
        const attempts = await createNodeAttemptRuntime(
          {
            database: config(fixture.workerUrl, 6),
            heartbeatIntervalMillis: 1_000,
            leaseDurationSeconds: 10,
            redisUrl: fixture.redisUrl,
            workerId: `recovery-${randomUUID()}`,
          },
          {
            registry: {
              dispatchMode: registry.dispatchMode,
              execute: async (request) => {
                if (request.runtime === undefined)
                  throw new Error('Missing real execution scope');
                if (request.definition.key === 'http.request') {
                  await request.runtime.beforeDispatch();
                  if (
                    request.runtime.nodeId === 'unknown-http' &&
                    unknownHttpFailure
                  ) {
                    unknownHttpFailure = false;
                    throw new NodeExecutorFailure({
                      kind: 'outcome_unknown',
                      errorKind: 'network',
                      possiblyDispatched: true,
                    });
                  }
                  if (httpFailure) {
                    httpFailure = false;
                    throw new NodeExecutorFailure({
                      kind: 'failed',
                      errorKind: 'authentication',
                      possiblyDispatched: true,
                    });
                  }
                  return {
                    kind: 'succeeded',
                    output: {
                      status: 200,
                      headers: {},
                      body: {
                        kind: 'inline',
                        encoding: 'utf8',
                        value: '{}',
                        byteLength: 2,
                      },
                      finalOrigin: 'https://example.test',
                      redirectCount: 0,
                    },
                  };
                }
                executed.push({
                  runId: request.runtime.runId,
                  nodeId: request.runtime.nodeId,
                });
                if (request.runtime.nodeId === 'target' && fail) {
                  fail = false;
                  throw new NodeExecutorFailure({
                    kind: 'failed',
                    errorKind: 'configuration',
                    possiblyDispatched: false,
                  });
                }
                return registry.execute(request);
              },
            },
          },
        );
        owners.push(() => attempts.close());
        const store = createOutboxDispatcherDatabase(
          config(fixture.dispatcherUrl, 2),
        );
        owners.push(() => store.close());
        const producer = createQueueProducer({ redisUrl: fixture.redisUrl });
        owners.push(() => producer.close());
        const dispatcher = new OutboxDispatcher(
          store,
          producer,
          new WorkerDrainState(),
          {
            batchSize: 10,
            jobNames: [
              JOB_NAME.advanceWorkflowRun,
              JOB_NAME.executeNodeAttempt,
            ],
            leaseDurationMillis: 30_000,
            leaseOwner: `recovery-${randomUUID()}`,
            maxAttempts: 3,
            retryDelayMillis: 1_000,
            pollIntervalMillis: 250,
          },
        );
        owners.splice(-2, 2, () => dispatcher.close());
        await Promise.all([
          coordinator.consumer.waitUntilReady(5_000),
          attempts.consumer.waitUntilReady(5_000),
          producer.waitUntilReady(5_000),
        ]);
        dispatcher.start();
        const key = createHash('sha256').update(randomUUID()).digest('hex');
        await fixture.ownerQuery(
          'insert into app.workspace_variables(workspace_id,revision,values_json) values($1,1,\'{"NAME":"original"}\')',
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
          'update app.workspace_variables set revision=2,values_json=\'{"NAME":"changed"}\' where workspace_id=$1',
          [fixture.workspaceId],
        );
        const before = await runs.get({
          workspaceId: fixture.workspaceId,
          runId: source.run.id,
        });
        const preview = await runs.recovery({
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
        if (preview.kind !== 'eligible')
          throw new Error('Source should qualify');
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
          workspaceId: fixture.workspaceId,
          workflowId,
        });
        expect(
          health?.items.find((step) => step.nodeId === 'prefix')?.runs,
        ).toBe(1);
        expect(
          health?.items.find((step) => step.nodeId === 'target')?.runs,
        ).toBe(2);
        expect(
          await runs.stepRuns({
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
            workspaceId: randomUUID(),
            runId: source.run.id,
            prepareRecovery,
          }),
        ).rejects.toBeInstanceOf(WorkflowRunNotFoundError);
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
          const httpKey = createHash('sha256')
            .update(randomUUID())
            .digest('hex');
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
            (rows) =>
              rows[0]?.status === (unknown ? 'outcome_unknown' : 'failed'),
            30_000,
          );
          const httpPreview = await runs.recovery({
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
  },
);
