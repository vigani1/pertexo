import { randomUUID } from 'node:crypto';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
} from '@pertexo/workflow-engine/server';
import { expect, it } from 'vitest';
import { executorFailureCompletion } from '../../../src/attempts/delivery/executor-failure.js';
import { API_KEY, fakeModel, json } from './model.fixture.js';

it.each([429, 503])(
  'schedules another attempt on HTTP %s at the provider minimum',
  async (status) => {
    await using fake = await fakeModel([
      json({ error: API_KEY }, status, { 'retry-after': '15' }),
    ]);
    const failure = await fake.execute().catch((error: unknown) => error);
    expect(failure).toMatchObject({
      kind: 'retry',
      errorKind: status === 429 ? 'rate_limit' : 'provider',
      minimumRetryDelayMillis: 15_000,
    });
    expect(fake.calls).toHaveLength(1);
    if (!(failure instanceof NodeExecutorFailure))
      throw new Error('Missing executor failure');
    const {
      status: _status,
      modelUsage,
      ...observation
    } = executorFailureCompletion(failure);
    expect(modelUsage).toEqual({
      kind: 'incomplete',
      model: 'fake',
      inputTokens: null,
      outputTokens: null,
    });

    const workflowVersionId = randomUUID();
    const signal = new AbortController().signal;
    const modelId = 'model';
    const manualId = 'manual';
    const executable = buildWorkflowExecutable({
      catalog: composeExecutableCatalog(PLATFORM_NODE_CATALOG),
      graph: {
        settings: { maxRunDurationMs: 600_000 },
        nodes: [
          {
            id: manualId,
            definition: { key: 'core.manual', version: 1 },
            configVersion: 1,
            position: { x: 0, y: 0 },
            config: {},
            inputMappings: {},
            connectionRefs: {},
          },
          {
            id: modelId,
            definition: { key: 'ai.model', version: 1 },
            configVersion: 1,
            position: { x: 0, y: 0 },
            config: { model: 'fake', mode: 'text' },
            inputMappings: {
              prompt: { kind: 'literal', value: 'mapped task' },
            },
            connectionRefs: { model_api_key: randomUUID() },
          },
        ],
        edges: [
          {
            id: 'start-model',
            source: { nodeId: manualId, port: 'out' },
            target: { nodeId: modelId, port: 'in' },
          },
        ],
      },
    });
    const context = {
      runId: randomUUID(),
      executable,
      workflowVersionId,
      signal,
      maximumAdmissions: 1,
    };
    const started = await advanceWorkflow({
      ...context,
      checkpoint: createCheckpoint({ workflowVersionId, iterationBudget: 0 }),
      occurredAt: '2026-11-21T10:00:00.000Z',
      observations: [],
    });
    const manual = started.attempts[0];
    if (manual === undefined) throw new Error('Missing manual attempt');
    const dispatched = await advanceWorkflow({
      ...context,
      checkpoint: started.checkpoint,
      occurredAt: '2026-11-21T10:00:01.000Z',
      observations: [
        {
          sequence: started.checkpoint.nextEventSequence,
          occurredAt: '2026-11-21T10:00:01.000Z',
          attemptId: randomUUID(),
          attemptNumber: manual.attemptNumber,
          kind: 'outcome',
          invocationKey: manual.invocationKey,
          status: 'succeeded',
        },
      ],
    });
    const model = dispatched.attempts[0];
    expect(model).toMatchObject({ nodeId: modelId, sideEffectClass: 'safe' });
    if (model === undefined) throw new Error('Missing model attempt');
    const retry = await advanceWorkflow({
      ...context,
      checkpoint: dispatched.checkpoint,
      occurredAt: '2026-11-21T10:00:02.000Z',
      observations: [
        {
          ...observation,
          kind: 'attempt_failure',
          occurredAt: '2026-11-21T10:00:02.000Z',
          invocationKey: model.invocationKey,
          attemptId: randomUUID(),
          attemptNumber: model.attemptNumber,
        },
      ],
    });
    expect(retry.events).toContainEqual(
      expect.objectContaining({
        name: 'node.retry_scheduled',
        dueAt: '2026-11-21T10:00:17.000Z',
      }),
    );
    expect(retry.attempts).toEqual([]);
  },
);
