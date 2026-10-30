import type { NodeExecutionCapabilityFactories } from '../../../src/attempts/execution/capabilities.js';
import { createHash, randomUUID } from 'node:crypto';
import { createDeadlineWakeupScanner } from '@pertexo/database/runs';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { createOutboxDispatcherDatabase } from '@pertexo/database/outbox';
import { createInitialCheckpoint } from '@pertexo/execution';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import { createPlatformNodeRegistry } from '@pertexo/node-catalog/server';
import { createQueueProducer, JOB_NAME } from '@pertexo/queue';
import { composeExecutableCatalog } from '@pertexo/workflow-engine';
import type {
  WorkflowGraph,
  WorkflowNode,
  WorkflowCallPin,
  CallableDeclaration,
} from '@pertexo/workflow-model';
import { vi } from 'vitest';
import { createCoordinatorRuntime } from '../../../src/runs/runtime.js';
import { createNodeAttemptRuntime } from '../../../src/attempts/delivery/runtime.js';
import { WorkerDrainState } from '../../../src/runtime/shutdown/drain-state.js';
import { OutboxDispatcher } from '../../../src/transport/outbox/dispatch/runtime.js';
import { coordinatorFixture } from '../../support/coordinator/consumer.js';
import { insertCompiledWorkflow } from '../../support/coordinator/workflows.js';
import { acceptManualFixtureRun } from '../../support/attempts/manual-start.js';
import { testNodeAttemptRuntime } from '../../support/runtime-factories.js';

export const fixture = coordinatorFixture;
export const node = (id: string, key: string): WorkflowNode => ({
  id,
  definition: { key, version: 1 },
  position: { x: 0, y: 0 },
  configVersion: 1,
  config: {},
  inputMappings: {},
  connectionRefs: {},
});
export const edge = (source: string, target: string, port = 'out') => ({
  id: `${source}-${target}`,
  source: { nodeId: source, port },
  target: { nodeId: target, port: 'in' },
});
const contract: CallableDeclaration = {
  input: {
    type: 'object',
    properties: [
      { name: 'name', valueType: { type: 'string' }, required: true },
    ],
  },
  resultType: { type: 'string' },
  result: {
    kind: 'expression',
    language: 'jsonata',
    expression: 'runInput.name & "!"',
  },
};
export function childGraph(waitSeconds?: number): WorkflowGraph {
  return {
    settings: { maxRunDurationMs: 60_000 },
    callable: contract,
    nodes: [
      node('manual', 'core.manual'),
      ...(waitSeconds === undefined
        ? []
        : [
            {
              ...node('wait', 'core.wait'),
              config: { durationSeconds: waitSeconds },
            },
          ]),
      node('finish', 'core.terminate'),
    ],
    edges:
      waitSeconds === undefined
        ? [edge('manual', 'finish')]
        : [edge('manual', 'wait'), edge('wait', 'finish')],
  };
}
export function parentGraph(target: WorkflowCallPin): WorkflowGraph {
  return {
    ...childGraph(),
    callable: {
      ...contract,
      result: { kind: 'node_output', nodeId: 'call', path: '$' },
    },
    nodes: [
      node('manual', 'core.manual'),
      {
        ...node('call', 'core.call'),
        config: { target: { ...target } },
        inputMappings: { input: { kind: 'run_input', path: '$' } },
      },
      {
        ...node('finish', 'core.terminate'),
        inputMappings: {
          result: { kind: 'node_output', nodeId: 'call', path: '$' },
        },
      },
    ],
    edges: [edge('manual', 'call'), edge('call', 'finish')],
  };
}
export async function publishGraph(graph: WorkflowGraph) {
  const identity = {
    workflowId: randomUUID(),
    workflowVersionId: randomUUID(),
  };
  const executable = await insertCompiledWorkflow(fixture.ownerQuery, {
    actorId: fixture.actorId,
    workspaceId: fixture.workspaceId,
    identity,
    graph,
    name: 'Call runtime proof',
    catalog: PLATFORM_NODE_CATALOG,
  });
  return {
    ...identity,
    executable,
    pin: { ...identity, executableChecksum: executable.checksum },
  };
}
export async function accept(
  parent: Awaited<ReturnType<typeof publishGraph>>,
  runInput: unknown = { name: 'Ada' },
) {
  const initial = createInitialCheckpoint(
    {
      id: parent.workflowVersionId,
      workspaceId: fixture.workspaceId,
      workflowId: parent.workflowId,
      versionNumber: 1,
      checksum: parent.executable.checksum,
      executableJson: parent.executable.envelope,
    },
    { catalog: composeExecutableCatalog(PLATFORM_NODE_CATALOG) },
  );
  return fixture.apiDatabase.withWorkspace(fixture.workspaceId, (transaction) =>
    acceptManualFixtureRun(transaction, {
      initialCheckpoint: initial.checkpoint,
      ...(initial.validateInput === undefined
        ? {}
        : { validateInput: initial.validateInput }),
      keyHash: createHash('sha256').update(randomUUID()).digest('hex'),
      requestHash: createHash('sha256')
        .update(JSON.stringify(runInput))
        .digest('hex'),
      operation: 'workflow.run.accept',
      scope: `workflow:${parent.workflowId}:manual`,
      triggerType: 'manual',
      workflowId: parent.workflowId,
      workflowVersionId: parent.workflowVersionId,
      runInput,
    }),
  );
}
export async function runtime(
  registry = createPlatformNodeRegistry(),
  capabilities: NodeExecutionCapabilityFactories = {},
) {
  const database = parseDatabaseConfig({
    connectionString: fixture.databaseUrl(fixture.workerUrl),
    max: 6,
  });
  const maintenanceDatabase = parseDatabaseConfig({
    connectionString: fixture.databaseUrl(fixture.dispatcherUrl),
    max: 2,
  });
  const owners: { close(): Promise<unknown> }[] = [];
  let coordinator:
    Awaited<ReturnType<typeof createCoordinatorRuntime>> | undefined;
  let attempts:
    Awaited<ReturnType<typeof createNodeAttemptRuntime>> | undefined;
  async function stopWorkers() {
    const errors: unknown[] = [];
    await attempts?.close().catch((error: unknown) => errors.push(error));
    await coordinator?.close().catch((error: unknown) => errors.push(error));
    attempts = undefined;
    coordinator = undefined;
    if (errors.length > 0)
      throw new AggregateError(errors, 'Call workers did not close');
  }
  async function startWorkers() {
    coordinator = await createCoordinatorRuntime({
      database,
      maintenanceDatabase,
      maximumAdmissions: 10,
      redisUrl: fixture.redisUrl,
    });
    attempts = await testNodeAttemptRuntime(
      {
        database,
        heartbeatIntervalMillis: 200,
        leaseDurationSeconds: 10,
        redisUrl: fixture.redisUrl,
        workerId: `call-${randomUUID()}`,
      },
      { registry, runtimeCapabilities: capabilities },
    );
    await Promise.all([
      coordinator.consumer.waitUntilReady(5_000),
      attempts.consumer.waitUntilReady(5_000),
    ]);
  }
  async function close() {
    const errors: unknown[] = [];
    await stopWorkers().catch((error: unknown) => errors.push(error));
    for (const owner of owners.reverse())
      await Promise.resolve()
        .then(() => owner.close())
        .catch((error: unknown) => errors.push(error));
    if (errors.length > 0)
      throw new AggregateError(errors, 'Call runtime cleanup failed');
  }
  try {
    const outbox = createOutboxDispatcherDatabase(maintenanceDatabase);
    owners.push(outbox);
    const producer = createQueueProducer({ redisUrl: fixture.redisUrl });
    owners.push(producer);
    const dispatcher = new OutboxDispatcher(outbox, producer, {
      drainState: new WorkerDrainState(),
      options: {
        batchSize: 20,
        jobNames: [JOB_NAME.advanceWorkflowRun, JOB_NAME.executeNodeAttempt],
        leaseDurationMillis: 1_000,
        leaseOwner: `call-${randomUUID()}`,
        maxAttempts: 10,
        operationTimeoutMillis: 2_000,
        pollIntervalMillis: 25,
        retryDelayMillis: 25,
      },
    });
    owners.splice(0, 2, dispatcher);
    const deadlines = createDeadlineWakeupScanner(database);
    owners.push(deadlines);
    await startWorkers();
    return {
      async until(check: () => Promise<void>, timeout = 15_000) {
        await vi.waitFor(
          async () => {
            await deadlines.claimDueWakeups(20);
            await dispatcher.dispatchOnce();
            await check();
          },
          { timeout, interval: 25 },
        );
      },
      pause: stopWorkers,
      async restart() {
        await stopWorkers();
        await startWorkers();
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function limitWorkspace(limit: number) {
  const [version] = await fixture.ownerQuery<{ version: number }>(
    `insert into app.workspace_execution_entitlement_versions(workspace_id,version,active_run_limit,queued_run_limit)
     select $1,coalesce(max(version),0)+1,$2,100 from app.workspace_execution_entitlement_versions where workspace_id=$1 returning version`,
    [fixture.workspaceId, limit],
  );
  if (version === undefined) throw new Error('Entitlement version missing');
  await fixture.ownerQuery(
    `insert into app.workspace_execution_entitlements(workspace_id,current_version) values($1,$2)
    on conflict(workspace_id) do update set current_version=excluded.current_version`,
    [fixture.workspaceId, version.version],
  );
}
