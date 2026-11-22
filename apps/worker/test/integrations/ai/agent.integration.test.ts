import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createWorkflowAuthoringStore } from '@pertexo/core/authoring';
import { createConnectionStore } from '@pertexo/core/connections';
import { createDataTablesStore } from '@pertexo/core/data-tables';
import {
  advanceRun,
  createWorkflowRunDatabase,
  initialCheckpointFactory,
} from '@pertexo/core/runs';
import { createOutboxDispatcherDatabase } from '@pertexo/core/testing';
import { createQueueProducer, JOB_NAME } from '@pertexo/queue/server';
import {
  ConnectionEnvelopeEncryption,
  parseAllowedPrivateNetworks,
} from '@pertexo/secrets/server';
import { buildWorkflowExecutable } from '@pertexo/workflow-engine/server';
import {
  AGENT_FIND_ROWS,
  type SecretConnectionAuthType,
} from '@pertexo/workflow-model';
import { WorkflowAuthoringValidator } from '@pertexo/workflow-model/server';

import { createNodeAttemptExecutionEngine } from '../../../src/attempts/execution/engine.js';
import { createWorkerNodeRuntimeCapabilities } from '../../../src/attempts/execution/runtime-capabilities.js';
import { WorkerDrainState } from '../../../src/runtime/shutdown/drain-state.js';
import { OutboxDispatcher } from '../../../src/transport/outbox/dispatch/outbox-dispatcher.runtime.js';
import {
  ContextKeyProvider,
  sealAndZero,
} from '../../support/attempts/http-node-attempt/encryption.js';
import { coordinatorFixture as fixture } from '../../support/coordinator/consumer.js';
import {
  testCoordinatorRuntime,
  testNodeAttemptRuntime,
} from '../../support/runtime-factories.js';
import { API_KEY, chat, fakeModel, json } from './model.fixture.js';
import {
  actor,
  agentRegistry,
  alias,
  catalog,
  commandKey,
  config,
  executableCatalog,
  model,
  publishAgent,
} from './agent.fixture.js';

const result = { text: 'Order a totals 42.' };

beforeAll(fixture.setup);
afterAll(fixture.restoreServicesAndClose);

it('publishes and runs an Agent with a bounded Find rows attempt', async () => {
  const query = {
    filters: [{ column: 'key', operator: 'equals', value: 'a' }],
    limit: 1,
  };
  await using provider = await fakeModel([
    json({
      usage: { prompt_tokens: 45, completion_tokens: 8 },
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            tool_calls: [
              {
                id: 'selected-order',
                type: 'function',
                function: { name: alias, arguments: JSON.stringify({ query }) },
              },
            ],
          },
        },
      ],
    }),
    json({
      ...chat(result.text),
      usage: { prompt_tokens: 80, completion_tokens: 7 },
    }),
  ]);
  const encryption = new ConnectionEnvelopeEncryption(new ContextKeyProvider());
  const database = config(fixture.workerUrl);
  const maintenanceDatabase = config(fixture.dispatcherUrl);
  const connectionId = randomUUID();
  const validator = new WorkflowAuthoringValidator();
  const authoring = createWorkflowAuthoringStore(config(fixture.apiUrl), {
    definitionCatalog: {
      definitions: catalog.definitions.map(({ definition }) => definition),
    },
    validateAuthoringGraph: (graph, options) =>
      validator.validate(
        graph,
        {
          definitions: catalog.definitions.map(
            ({ definition, capabilities, policyReferences }) => ({
              definition,
              capabilities,
              policyReferences,
            }),
          ),
        },
        options,
      ),
    executableCompiler: (graph) => {
      const compiled = buildWorkflowExecutable({
        graph,
        catalog: executableCatalog,
      });
      return { checksum: compiled.checksum, executableJson: compiled.envelope };
    },
  });
  const tables = createDataTablesStore(config(fixture.apiUrl));
  const connections = createConnectionStore(config(fixture.apiUrl));
  const runs = createWorkflowRunDatabase(config(fixture.apiUrl));
  const owners = [
    () => validator.shutdown(),
    authoring.close,
    tables.close,
    connections.close,
    runs.close,
  ];
  try {
    const table = await tables.create({
      ...actor,
      idempotencyKey: randomUUID(),
      name: 'Agent Orders',
      columns: [
        { name: 'key', type: 'text', required: true },
        { name: 'amount', type: 'number', required: true },
      ],
      keyColumn: 'key',
    });
    await tables.importRows({
      ...actor,
      idempotencyKey: randomUUID(),
      tableId: table.id,
      rows: [
        { key: 'a', amount: 42 },
        { key: 'b', amount: 99 },
      ],
    });
    const secretVersionId = randomUUID();
    const sealed = await sealAndZero(
      encryption,
      Buffer.from(
        JSON.stringify({
          type: 'model_api_key',
          endpoint: 'vllm',
          baseUrl: provider.baseUrl,
          apiKey: API_KEY,
        }),
      ),
      {
        workspaceId: actor.workspaceId,
        connectionId,
        secretVersionId,
      },
    );
    await connections.createConnection({
      ...actor,
      connectionId,
      secretVersionId,
      providerKey: 'ai',
      authType: 'model_api_key' as SecretConnectionAuthType,
      name: 'Agent fixture model',
      sealed,
      idempotencyKey: randomUUID(),
      requestHash: commandKey(),
    });
    const workflowId = await publishAgent(authoring, connectionId);
    const coordinator = await testCoordinatorRuntime(
      {
        database,
        maintenanceDatabase,
        maximumAdmissions: 10,
        redisUrl: fixture.redisUrl,
      },
      {},
      {
        advance: (dependencies) => (input) =>
          advanceRun(
            {
              ...dependencies,
              verification: { catalog: executableCatalog },
              agentModelRates: (name) =>
                name === model ? { input: 0, output: 0 } : undefined,
            },
            input,
          ),
      },
    );
    owners.push(() => coordinator.close());
    const allowedPrivateNetworks = parseAllowedPrivateNetworks('127.0.0.1/32');
    const attempts = await testNodeAttemptRuntime(
      {
        database,
        heartbeatIntervalMillis: 1000,
        leaseDurationSeconds: 30,
        redisUrl: fixture.redisUrl,
        workerId: `agent-${randomUUID()}`,
      },
      {
        engine: createNodeAttemptExecutionEngine({
          catalog: executableCatalog,
        }),
        registry: agentRegistry(allowedPrivateNetworks),
        capabilityFactory: (options) =>
          createWorkerNodeRuntimeCapabilities(
            { ...options, allowedPrivateNetworks },
            { connectionEncryption: encryption },
          ),
      },
    );
    owners.push(() => attempts.close());
    const producer = createQueueProducer({ redisUrl: fixture.redisUrl });
    const dispatcher = new OutboxDispatcher(
      createOutboxDispatcherDatabase(maintenanceDatabase),
      producer,
      {
        drainState: new WorkerDrainState(),
        options: {
          batchSize: 10,
          jobNames: [JOB_NAME.advanceWorkflowRun, JOB_NAME.executeNodeAttempt],
          leaseDurationMillis: 30_000,
          leaseOwner: `agent-${randomUUID()}`,
          retryDelayMillis: 250,
          operationTimeoutMillis: 5000,
          pollIntervalMillis: 100,
        },
      },
    );
    owners.push(() => dispatcher.close());
    await Promise.all([
      coordinator.consumer.waitUntilReady(5000),
      attempts.consumer.waitUntilReady(5000),
      producer.waitUntilReady(5000),
    ]);
    dispatcher.start();
    const key = commandKey();
    const accepted = await runs.start({
      ...actor,
      workflowId,
      idempotencyKeyHash: key,
      requestHash: key,
      scope: `workflow:${workflowId}:manual`,
      input: {},
      checkpointFactory: initialCheckpointFactory({
        catalog: executableCatalog,
      }),
    });
    const status = await fixture.waitFor(
      () =>
        fixture.workerQuery<{
          status: string;
          output_ref: unknown;
          error_summary: unknown;
        }>(
          'select status,output_ref,error_summary from app.workflow_runs where id=$1',
          [accepted.run.id],
        ),
      (rows) =>
        ['succeeded', 'failed', 'timed_out', 'outcome_unknown'].includes(
          rows[0]?.status ?? '',
        ),
      20_000,
    );
    const history = await fixture.workerQuery<{ invocation_key: string }>(
      `select n.invocation_key,n.input_ref,a.status,a.output_ref,a.dispatch_marked_at
       from app.node_attempts a join app.node_runs n on n.id=a.node_run_id
       where n.workflow_run_id=$1 and n.node_id='agent' order by a.started_at`,
      [accepted.run.id],
    );
    expect(provider.calls[0]?.request).toMatchObject({
      tools: [
        {
          function: {
            name: alias,
            parameters: {
              properties: { query: expect.any(Object) as unknown },
            },
          },
        },
      ],
    });
    expect(history).toMatchObject([
      {
        status: 'succeeded',
        output_ref: {
          value: { proposal: { name: alias, arguments: { query } } },
        },
      },
      {
        status: 'succeeded',
        dispatch_marked_at: expect.any(Date) as unknown,
        input_ref: { value: { query } },
        output_ref: { value: { rows: [{ values: { key: 'a', amount: 42 } }] } },
      },
      { status: 'succeeded', output_ref: { value: result } },
    ]);
    expect(
      new Set(history.map(({ invocation_key }) => invocation_key)).size,
    ).toBe(3);
    const [admission] = await fixture.workerQuery<{ agent_work: unknown }>(
      `select payload->'agentWork' as agent_work from app.run_events
       where workflow_run_id=$1 and type='node.ready' and payload->>'invocationKey'=$2`,
      [accepted.run.id, history[1]?.invocation_key],
    );
    expect(admission?.agent_work).toMatchObject({
      parentInvocationKey: expect.any(String) as unknown,
      definition: AGENT_FIND_ROWS,
      alias,
      work: { kind: 'tool_call', ordinal: 1 },
    });
    const messages = (
      provider.calls[1]?.request as {
        messages: { role: string; content: string }[];
      }
    ).messages;
    const tool = messages.find(({ role }) => role === 'tool');
    expect(tool).toBeDefined();
    expect(JSON.parse(tool?.content ?? 'null')).toMatchObject({
      rows: [{ values: { key: 'a', amount: 42 } }],
    });
    expect(status).toMatchObject([
      {
        status: 'succeeded',
        output_ref: { value: result },
        error_summary: null,
      },
    ]);
  } finally {
    await Promise.allSettled(owners.reverse().map((close) => close()));
  }
});
