import type { JsonValue } from '@pertexo/workflow-model';
import { randomUUID } from 'node:crypto';
import {
  boundedNodeJsonRecordSchema,
  createNodeCatalog,
  executorManifestFor,
  generateSchemaDocument,
  type NodeManifest,
} from '@pertexo/node-sdk';
import {
  createInlineNodeRegistry,
  type InlineNodeResult,
} from '@pertexo/node-sdk/server';
import { describe, expect, it } from 'vitest';
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
  type InlineAdvanceOptions,
} from '../../../src/server.js';
import {
  conditionGraph,
  manifest,
  nodeCatalog,
  pairedParallelGraph,
} from '../../support/executable-workflow.js';

const workflowVersionId = '00000000-0000-4000-8000-000000000601';
const occurredAt = '2026-11-21T10:00:00.000Z';

describe('inline control steps', () => {
  it('admits the branch selected by a locally completed Condition', async () => {
    const { input, initial } = await startControl(
      'core.condition',
      conditionGraph('true'),
      { kind: 'succeeded', output: { selectedPort: 'true' } },
    );
    const plan = await observeSuccess(input, initial, 'manual', {});
    expect(plan.inlineAttempts).toMatchObject([
      {
        nodeId: 'condition',
        kind: 'succeeded',
        output: { selectedPort: 'true' },
      },
    ]);
    expect(plan.attempts).toMatchObject([{ nodeId: 'terminate' }]);
  });

  it('reports a missing selected Merge value as stored checkpoint corruption', async () => {
    const { input, initial } = await startControl(
      'core.merge',
      pairedParallelGraph(),
      {
        kind: 'succeeded',
        output: {},
      },
    );
    const manual = await observeSuccess(input, initial, 'manual', {});
    const parallel = await observeSuccess(input, manual, 'parallel', {
      branchIds: ['branch-02', 'branch-01'],
    });
    const left = await observeSuccess(input, parallel, 'left', { total: 1 });
    await expect(
      observeSuccess(input, left, 'right', { total: 2 }),
    ).rejects.toMatchObject({
      code: 'checkpoint_invalid',
      message: 'settled Merge output is missing',
    });
  });
});

async function startControl(
  kind: 'core.condition' | 'core.merge',
  graph:
    ReturnType<typeof conditionGraph> | ReturnType<typeof pairedParallelGraph>,
  result: InlineNodeResult,
) {
  const identity = { key: kind, version: 2 };
  const schema = boundedNodeJsonRecordSchema;
  const document = generateSchemaDocument(schema);
  const pin = {
    ...manifest(kind),
    definition: identity,
    executor: identity,
    execution: 'inline',
    configSchema: document,
    inputSchema: document,
    outputSchema: document,
  } as const satisfies NodeManifest;
  const executor = executorManifestFor(pin);
  const base = nodeCatalog({ parallel: true });
  const catalog = createNodeCatalog({
    definitions: [...base.definitions, pin],
    executors: [...base.executors, executor],
    policies: base.policies,
  });
  const registry = createInlineNodeRegistry({
    catalog: createNodeCatalog({
      definitions: [pin],
      executors: [executor],
      policies: pin.policyReferences,
    }),
    definitions: [],
    executors: [],
    core: {
      definitions: [
        {
          manifest: pin,
          configSchema: schema,
          inputSchema: schema,
          outputSchema: schema,
        },
      ],
      executors: [
        {
          executor: identity,
          execute: () =>
            Promise.reject(
              new Error('Control fixture expects inline execution'),
            ),
          executeInline: () => result,
        },
      ],
    },
  });
  const executable = buildWorkflowExecutable({
    graph: {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.definition.key === kind ? { ...node, definition: identity } : node,
      ),
    },
    catalog: composeExecutableCatalog(catalog),
  });
  const inline: InlineAdvanceOptions = {
    registry,
    now: () => Date.parse(occurredAt),
    monotonicNow: () => 0,
    newAttemptId: randomUUID,
    readValues: () =>
      Promise.resolve({ runInput: null, outputs: [], attemptOutputs: [] }),
    normalizeFailure: () => ({
      errorKind: 'configuration',
      failureKind: 'failed',
      safeErrorCode: 'execution.input_invalid',
    }),
  };
  const input = {
    runId: kind,
    workflowVersionId,
    executable,
    occurredAt,
    maximumAdmissions: 10,
    signal: new AbortController().signal,
    inline,
  };
  const initial = await advanceWorkflow({
    ...input,
    checkpoint: createCheckpoint({ workflowVersionId, iterationBudget: 0 }),
  });
  return { input, initial };
}

function observeSuccess(
  input: Awaited<ReturnType<typeof startControl>>['input'],
  previous: Awaited<ReturnType<typeof advanceWorkflow>>,
  nodeId: string,
  value: JsonValue,
) {
  const admission = previous.attempts.find(
    (attempt) => attempt.nodeId === nodeId,
  );
  if (admission === undefined)
    throw new Error(`Missing admission for ${nodeId}`);
  const attemptId = randomUUID();
  const sequence = previous.checkpoint.nextEventSequence;
  const identity = {
    attemptId,
    invocationKey: admission.invocationKey,
    sequence,
  };
  return advanceWorkflow({
    ...input,
    checkpoint: previous.checkpoint,
    observations: [
      {
        ...identity,
        kind: 'outcome',
        status: 'succeeded',
        occurredAt,
        attemptNumber: admission.attemptNumber,
        output: { kind: 'inline', attemptId },
      },
    ],
    completedOutputs: [{ ...identity, value }],
  });
}
