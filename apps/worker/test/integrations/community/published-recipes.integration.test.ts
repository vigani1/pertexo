import { createHash, randomUUID } from 'node:crypto';
import {
  createConnectionStore,
  createWorkerConnectionResolutionStore,
} from '@pertexo/core/connections';
import {
  createWorkflowRunDatabase,
  initialCheckpointFactory,
} from '@pertexo/core/runs';
import { createOutboxDispatcherDatabase } from '@pertexo/core/testing';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import { createQueueProducer, JOB_NAME } from '@pertexo/queue/server';
import {
  ConnectionEnvelopeEncryption,
  SecureHttpClient,
  type SecureHttpTransport,
} from '@pertexo/secrets/server';
import { composeExecutableCatalog } from '@pertexo/workflow-engine/server';
import type { SecretConnectionAuthType } from '@pertexo/workflow-model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { provideHttpClient } from '../../../src/providers/http-client.js';
import { createPlatformNodeRegistry } from '../../../src/providers/node-registry.js';
import { createProviderConnectionRuntimeFactory } from '../../../src/providers/connections.js';
import { createCoordinatorRuntime } from '../../../src/runs/coordinator.runtime.js';
import { WorkerDrainState } from '../../../src/runtime/shutdown/drain-state.js';
import { OutboxDispatcher } from '../../../src/transport/outbox/dispatch/outbox-dispatcher.runtime.js';
import {
  ContextKeyProvider,
  sealAndZero,
} from '../../support/attempts/http-node-attempt/encryption.js';
import { coordinatorFixture as fixture } from '../../support/coordinator/consumer.js';
import { insertCompiledWorkflow } from '../../support/coordinator/workflows.js';
import {
  edgesFromTuples,
  manualNode,
} from '../../support/coordinator/workflows/nodes.js';
import { testNodeAttemptRuntime } from '../../support/runtime-factories.js';
import {
  approveRecipes,
  origin,
  providerKey,
  readPath,
  recipeForm,
  recipeNode,
  token,
} from './recipes.fixture.js';

const owners: (() => Promise<void>)[] = [];
const requests: {
  url: string;
  credentials: string | undefined;
  method: string;
  body: string | undefined;
}[] = [];
const dispatch: SecureHttpTransport['dispatch'] = async (request) => {
  await Promise.resolve();
  requests.push({
    url: request.url.href,
    credentials: request.headers['x-widget-key'],
    method: request.method,
    body:
      request.body instanceof Uint8Array
        ? new TextDecoder().decode(request.body)
        : undefined,
  });
  if (request.method === 'POST')
    throw new Error('The provider lost the response after receiving the write');
  const status = requests.length === 1 ? 503 : 200;
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: (async function* () {
      await Promise.resolve();
      yield new TextEncoder().encode(
        JSON.stringify({ result: { echo: token } }),
      );
    })(),
    close() {},
  };
};

const config = (url: string) =>
  parseDatabaseConfig({ connectionString: fixture.databaseUrl(url), max: 4 });
const actor = { actorId: fixture.actorId, workspaceId: fixture.workspaceId };
const connectionId = randomUUID();
let rotateCredential: (() => Promise<void>) | undefined;
let rotateBeforeDispatch = false;
const commandKey = () =>
  createHash('sha256').update(randomUUID()).digest('hex');

describe.skipIf(!fixture.enabled)('published community recipes', () => {
  beforeAll(async () => {
    await approveRecipes();
    await fixture.setup();
    await startWorkers();
  }, 60_000);
  afterAll(async () => {
    try {
      for (const close of owners.reverse()) await close();
    } finally {
      await fixture.restoreServicesAndClose();
    }
  });

  it('retries a safe response and stores projected redacted output', async () => {
    requests.length = 0;
    const runId = await runRecipe('read', 'succeeded');
    expect(requests).toEqual(
      Array.from({ length: 2 }, () => ({
        url: origin + readPath,
        credentials: token,
        method: 'GET',
        body: undefined,
      })),
    );
    const attempts = await attemptsFor(runId);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.dispatch_marked_at).not.toBeNull();
    expect(JSON.stringify(attempts)).not.toContain(token);
    expect(attempts[1]?.output_ref).toMatchObject({
      kind: 'inline',
      value: { echo: '[Redacted]' },
    });
  });

  it('dispatches an ambiguous write once and settles it as unknown', async () => {
    requests.length = 0;
    const runId = await runRecipe('write', 'outcome_unknown');
    expect(requests).toEqual([
      {
        url: origin + '/widgets/North%20%26%20East',
        credentials: token,
        method: 'POST',
        body: '{"count":2}',
      },
    ]);
    const attempts = await attemptsFor(runId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.dispatch_marked_at).not.toBeNull();
  });
  it('refuses a credential version rotated after resolution and before dispatch', async () => {
    requests.length = 0;
    rotateBeforeDispatch = true;
    const runId = await runRecipe('read', 'failed');
    expect(requests).toEqual([]);
    const attempts = await attemptsFor(runId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.dispatch_marked_at).toBeNull();
  });
});

async function startWorkers() {
  const database = config(fixture.workerUrl);
  const maintenanceDatabase = config(fixture.dispatcherUrl);
  const encryption = new ConnectionEnvelopeEncryption(new ContextKeyProvider());
  rotateCredential = await storeCredential(encryption);
  const connectionStore = createWorkerConnectionResolutionStore(database);
  owners.push(connectionStore.close);
  const connections = createProviderConnectionRuntimeFactory(
    connectionStore,
    encryption,
    {
      consume: () =>
        Promise.resolve({ allowed: true, retryAfterSeconds: 0, remaining: 5 }),
    },
  );
  const httpClient = provideHttpClient(
    new SecureHttpClient(
      {
        resolve: async () => {
          if (rotateBeforeDispatch) {
            rotateBeforeDispatch = false;
            await rotateCredential?.();
          }
          return [{ address: '93.184.216.34', family: 4 }];
        },
      },
      { dispatch },
    ),
  );
  const coordinator = await createCoordinatorRuntime({
    database,
    maintenanceDatabase,
    redisUrl: fixture.redisUrl,
    maximumAdmissions: 10,
    inlineSteps: fixture.inlineSteps,
  });
  owners.push(coordinator.close);
  const workerId = `community-${randomUUID()}`;
  const attempts = await testNodeAttemptRuntime(
    {
      database,
      redisUrl: fixture.redisUrl,
      workerId,
      heartbeatIntervalMillis: 1_000,
      leaseDurationSeconds: 10,
    },
    {
      registry: createPlatformNodeRegistry({ httpClient }),
      runtimeCapabilities: { connections },
    },
  );
  owners.push(attempts.close);
  const dispatcher = new OutboxDispatcher(
    createOutboxDispatcherDatabase(maintenanceDatabase),
    createQueueProducer({ redisUrl: fixture.redisUrl }),
    {
      drainState: new WorkerDrainState(),
      options: {
        batchSize: 10,
        jobNames: [JOB_NAME.advanceWorkflowRun, JOB_NAME.executeNodeAttempt],
        leaseDurationMillis: 30_000,
        leaseOwner: workerId,
        retryDelayMillis: 1_000,
        operationTimeoutMillis: 5_000,
        pollIntervalMillis: 100,
      },
    },
  );
  owners.push(() => dispatcher.close());
  await Promise.all([
    coordinator.consumer.waitUntilReady(5_000),
    attempts.consumer.waitUntilReady(5_000),
  ]);
  dispatcher.start();
}

async function storeCredential(encryption: ConnectionEnvelopeEncryption) {
  const { authType } = recipeForm();
  const store = createConnectionStore(config(fixture.apiUrl));
  owners.push(store.close);
  const original = randomUUID();
  const seal = (value: string, secretVersionId: string) =>
    sealAndZero(
      encryption,
      new TextEncoder().encode(
        JSON.stringify({ type: authType, token: value }),
      ),
      { workspaceId: fixture.workspaceId, connectionId, secretVersionId },
    );
  await store.createConnection({
    ...actor,
    connectionId,
    secretVersionId: original,
    providerKey,
    authType: authType as SecretConnectionAuthType,
    name: 'Widgets production fixture',
    sealed: await seal(token, original),
    idempotencyKey: randomUUID(),
    requestHash: commandKey(),
  });
  return async () => {
    const secretVersionId = randomUUID();
    await store.rotateConnectionSecret({
      ...actor,
      connectionId,
      secretVersionId,
      expectedCurrentSecretVersionId: original,
      expectedProviderKey: providerKey,
      sealed: await seal('rotated-widget-credential', secretVersionId),
      idempotencyKey: randomUUID(),
      requestHash: commandKey(),
    });
  };
}

async function runRecipe(
  action: 'read' | 'write',
  status: 'succeeded' | 'outcome_unknown' | 'failed',
) {
  const workflowId = randomUUID();
  const workflowVersionId = randomUUID();
  const { node } = recipeNode(action, connectionId);
  await insertCompiledWorkflow(fixture.ownerQuery, {
    ...actor,
    identity: { workflowId, workflowVersionId },
    name: 'Community recipe proof',
    catalog: PLATFORM_NODE_CATALOG,
    graph: {
      nodes: [
        manualNode,
        {
          ...node,
          position: { x: 1, y: 1 },
          retry: { maximumAttempts: 2, delayMillis: 1_000 },
        },
      ],
      edges: edgesFromTuples([
        ['widgets-edge', 'manual', 'out', node.id, 'in'],
      ]),
      settings: { maxRunDurationMs: 60_000 },
    },
  });
  await fixture.ownerQuery(
    'update app.workflows set published_version_id=$2 where id=$1',
    [workflowId, workflowVersionId],
  );
  const runs = createWorkflowRunDatabase(config(fixture.apiUrl));
  try {
    const key = commandKey();
    const { run } = await runs.start({
      ...actor,
      workflowId,
      idempotencyKeyHash: key,
      requestHash: key,
      scope: `workflow:${workflowId}:manual`,
      input: {},
      checkpointFactory: initialCheckpointFactory({
        catalog: composeExecutableCatalog(PLATFORM_NODE_CATALOG),
      }),
    });
    await fixture.waitFor(
      () => runs.get({ ...actor, runId: run.id }),
      (result) => result?.run.status === status,
    );
    return run.id;
  } finally {
    await runs.close();
  }
}

function attemptsFor(runId: string) {
  return fixture.workerQuery<{
    diagnostics: unknown;
    output_ref: unknown;
    dispatch_marked_at: Date | null;
  }>(
    `select attempt.diagnostics, node.output_ref, attempt.dispatch_marked_at
       from app.node_attempts attempt
       join app.node_runs node on node.id=attempt.node_run_id
       where node.workflow_run_id=$1 and node.node_id='widgets'
       order by attempt.attempt_number`,
    [runId],
  );
}
