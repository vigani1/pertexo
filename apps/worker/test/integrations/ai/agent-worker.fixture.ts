import { writeSync } from 'node:fs';
import { createNodeAttemptRunStore } from '@pertexo/core/attempts';
import {
  advanceRun,
  createRunAdvanceStore,
  createStalledWorkStore,
} from '@pertexo/core/runs';
import { createOutboxDispatcherDatabase } from '@pertexo/core/testing';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { createQueueProducer, JOB_NAME } from '@pertexo/queue/server';
import {
  ConnectionEnvelopeEncryption,
  parseAllowedPrivateNetworks,
} from '@pertexo/secrets/server';
import { createNodeAttemptRuntime } from '../../../src/attempts/delivery/node-attempt.runtime.js';
import { createNodeAttemptExecutionEngine } from '../../../src/attempts/execution/engine.js';
import { createWorkerNodeRuntimeCapabilities } from '../../../src/attempts/execution/runtime-capabilities.js';
import { createCoordinatorRuntime } from '../../../src/runs/coordinator.runtime.js';
import { WorkerDrainState } from '../../../src/runtime/shutdown/drain-state.js';
import { OutboxDispatcher } from '../../../src/transport/outbox/dispatch/outbox-dispatcher.runtime.js';
import { ContextKeyProvider } from '../../support/attempts/http-node-attempt/encryption.js';
import { agentRegistry, executableCatalog } from './agent-registry.fixture.js';

export interface AgentWorkerSettings {
  databaseUrl: string;
  maintenanceUrl: string;
  redisUrl: string;
  workerId: string;
  key: string;
  inputRate: number;
  pause?: 'proposal' | 'receipt';
}

async function run(settings: AgentWorkerSettings) {
  const database = parseDatabaseConfig({
    connectionString: settings.databaseUrl,
    max: 6,
  });
  const maintenanceDatabase = parseDatabaseConfig({
    connectionString: settings.maintenanceUrl,
    max: 6,
  });
  const { redisUrl, workerId } = settings;
  const pause = (stage: string) => {
    writeSync(1, `Agent worker paused: ${stage}\n`);
    process.kill(process.pid, 'SIGSTOP');
  };
  const coordinator = await createCoordinatorRuntime(
    { database, maintenanceDatabase, maximumAdmissions: 10, redisUrl },
    {
      runStore: (...args) => {
        const store = createRunAdvanceStore(...args);
        return {
          ...store,
          advance: async (input, decide) => {
            const committed = { proposed: false };
            const result = await store.advance(input, async (state) => {
              const decision = await decide(state);
              committed.proposed =
                decision.kind === 'transition' &&
                decision.plan.checkpoint.agents?.some(
                  ({ phase }) => phase.kind === 'proposed_call',
                ) === true;
              return decision;
            });
            if (
              result.kind === 'committed' &&
              committed.proposed &&
              settings.pause === 'proposal'
            )
              pause('proposal');
            return result;
          },
        };
      },
      advance: (dependencies) => (input) =>
        advanceRun(
          {
            ...dependencies,
            verification: { catalog: executableCatalog },
            agentModelRates: () => ({ input: settings.inputRate, output: 0 }),
          },
          input,
        ),
    },
  );
  const allowedPrivateNetworks = parseAllowedPrivateNetworks('127.0.0.1/32');
  const attempts = await createNodeAttemptRuntime(
    {
      database,
      heartbeatIntervalMillis: 1000,
      leaseDurationSeconds: 5,
      redisUrl,
      workerId,
    },
    {
      engine: () =>
        createNodeAttemptExecutionEngine({ catalog: executableCatalog }),
      registry: () => agentRegistry(allowedPrivateNetworks),
      capabilities: (options) =>
        createWorkerNodeRuntimeCapabilities(
          { ...options, allowedPrivateNetworks },
          {
            connectionEncryption: new ConnectionEnvelopeEncryption(
              new ContextKeyProvider(Buffer.from(settings.key, 'hex')),
            ),
          },
        ),
      runStore: (...args) => {
        const store = createNodeAttemptRunStore(...args);
        return {
          ...store,
          complete: async (input) => {
            const result = await store.complete(input);
            if (
              settings.pause === 'receipt' &&
              result.kind === 'committed' &&
              input.outcome.status === 'succeeded' &&
              typeof input.outcome.output === 'object' &&
              input.outcome.output !== null &&
              'rows' in input.outcome.output
            )
              pause('receipt');
            return result;
          },
        };
      },
    },
  );
  const producer = createQueueProducer({ redisUrl });
  const dispatcher = new OutboxDispatcher(
    createOutboxDispatcherDatabase(maintenanceDatabase),
    producer,
    {
      drainState: new WorkerDrainState(),
      options: {
        batchSize: 10,
        jobNames: [JOB_NAME.advanceWorkflowRun, JOB_NAME.executeNodeAttempt],
        leaseDurationMillis: 5_000,
        leaseOwner: workerId,
        retryDelayMillis: 250,
        operationTimeoutMillis: 5_000,
        pollIntervalMillis: 100,
      },
    },
  );
  await Promise.all([
    coordinator.consumer.waitUntilReady(5_000),
    attempts.consumer.waitUntilReady(5_000),
    producer.waitUntilReady(5_000),
  ]);
  const recovery = createStalledWorkStore(maintenanceDatabase);
  dispatcher.start();
  writeSync(1, 'Agent worker ready\n');
  const signal = new AbortController().signal;
  for (;;) {
    const { failed, stagesFailed } = await recovery.recoverDue(10, signal);
    if (failed.length !== 0 || stagesFailed.length !== 0)
      throw new AggregateError(
        [...failed, ...stagesFailed].map(({ error }) => error),
        'Agent recovery scan failed',
      );
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

// The test runner imports only the settings type. ServiceProcess runs this entry.
await run(
  JSON.parse(process.env.AGENT_WORKER_FIXTURE ?? '') as AgentWorkerSettings,
);
