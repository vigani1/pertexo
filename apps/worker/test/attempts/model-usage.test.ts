import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import type { NodeAttemptRunStore } from '@pertexo/core/testing';
import { composeExecutableCatalog } from '@pertexo/workflow-engine/server';
import { expect, it, vi } from 'vitest';

import { createNodeAttemptExecutionEngine } from '../../src/attempts/execution/engine.js';
import { createNodeAttemptHandler } from '../../src/testing.js';
import {
  chat,
  fakeModel,
  json,
  modelConnectionId,
  modelStep,
  schema,
} from '../integrations/ai/model.fixture.js';
import { graph } from '../support/attempts/execution-engine.js';
import {
  delivery,
  executionStore,
  lease,
  projection,
  WORKFLOW_ID,
} from '../support/attempts/node-attempt-handler.fixture.js';
import { compiledProjection } from './engine.fixture.js';

it.each(['executor_failure', 'timed_out', 'canceled'] as const)(
  'writes the observed usage when a dispatched model repair ends as %s',
  async (status) => {
    let repairDispatched = false;
    const repairFailure = json({}, 500);
    await using fake = await fakeModel([
      json({
        ...chat('{}'),
        usage: { prompt_tokens: 12, completion_tokens: 2 },
      }),
      (response, call) => {
        repairDispatched = true;
        if (status === 'executor_failure') repairFailure(response, call);
      },
    ]);
    const source = graph();
    const catalog = composeExecutableCatalog(PLATFORM_NODE_CATALOG);
    const published = compiledProjection(
      {
        ...source,
        nodes: source.nodes.map((node) =>
          node.id === 'terminate'
            ? {
                ...node,
                definition: modelStep,
                config: {
                  model: 'fake',
                  mode: 'structured',
                  outputSchema: schema,
                },
                connectionRefs: { model_api_key: modelConnectionId },
                inputMappings: {
                  prompt: { kind: 'literal', value: 'Count items' },
                },
              }
            : node,
        ),
      },
      catalog,
    );
    const claimed = lease();
    const complete = vi
      .fn<NodeAttemptRunStore['complete']>()
      .mockResolvedValue({ kind: 'committed', outboxEventId: WORKFLOW_ID });
    const handler = createNodeAttemptHandler({
      engine: createNodeAttemptExecutionEngine({ catalog }),
      heartbeatIntervalMillis: 10,
      leaseDurationSeconds: 30,
      reader: {
        close: vi.fn(),
        readForExecution: vi.fn().mockResolvedValue({
          ...projection(),
          checksum: published.checksum,
          executableJson: published.executableJson,
        }),
      },
      registry: fake.registry,
      runtimeCapabilities: { connections: () => fake.connections() },
      runStore: executionStore({
        claimDelivery: vi.fn().mockResolvedValue({
          kind: 'claimed',
          lease: {
            ...claimed,
            nodeId: 'terminate',
            invocationKey: `${claimed.workflowVersionId}|terminate|b:|i:`,
          },
        }),
        complete,
        heartbeat: vi
          .fn<NodeAttemptRunStore['heartbeat']>()
          .mockImplementation(() =>
            Promise.resolve({
              leaseExpiresAt: claimed.leaseExpiresAt,
              control:
                repairDispatched && status !== 'executor_failure'
                  ? { kind: 'abort', reason: status }
                  : { kind: 'none' },
            }),
          ),
      }),
      workerId: claimed.workerId,
    });
    await expect(
      handler.handle(delivery(), { signal: new AbortController().signal }),
    ).resolves.toEqual({ kind: 'committed' });
    expect(fake.calls).toHaveLength(2);
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.lastCall?.[0]).toMatchObject({
      outcome: { status },
      modelUsage: {
        kind: 'incomplete',
        model: 'fake',
        inputTokens: 12,
        outputTokens: 2,
      },
    });
  },
);
