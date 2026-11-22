import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { advanceRun } from '@pertexo/core/runs';
import { createOutboxDispatcherDatabase } from '@pertexo/core/testing';
import { createQueueProducer, JOB_NAME } from '@pertexo/queue/server';
import {
  ConnectionEnvelopeEncryption,
  parseAllowedPrivateNetworks,
} from '@pertexo/secrets/server';
import { AGENT_FIND_ROWS } from '@pertexo/workflow-model';

import { createNodeAttemptExecutionEngine } from '../../../src/attempts/execution/engine.js';
import { createWorkerNodeRuntimeCapabilities } from '../../../src/attempts/execution/runtime-capabilities.js';
import { WorkerDrainState } from '../../../src/runtime/shutdown/drain-state.js';
import { OutboxDispatcher } from '../../../src/transport/outbox/dispatch/outbox-dispatcher.runtime.js';
import { ContextKeyProvider } from '../../support/attempts/http-node-attempt/encryption.js';
import { coordinatorFixture as fixture } from '../../support/coordinator/consumer.js';
import {
  testCoordinatorRuntime,
  testNodeAttemptRuntime,
} from '../../support/runtime-factories.js';
import { chat, fakeModel, json } from './model.fixture.js';
import { agentRegistry, executableCatalog } from './agent-registry.fixture.js';
import { alias, config, model } from './agent.fixture.js';

import { startAgentRun } from './agent-run.fixture.js';

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
  const runId = await startAgentRun(provider.baseUrl, encryption);
  const owners: (() => Promise<void>)[] = [];
  try {
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
    const status = await fixture.waitFor(
      () =>
        fixture.workerQuery<{
          status: string;
          output_ref: unknown;
          error_summary: unknown;
        }>(
          'select status,output_ref,error_summary from app.workflow_runs where id=$1',
          [runId],
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
      [runId],
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
      [runId, history[1]?.invocation_key],
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
