import type { WorkflowEdge } from '@pertexo/workflow-model';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createNodeCatalog,
  executorManifestFor,
  boundedNodeJsonRecordSchema,
  generateSchemaDocument,
  type NodeManifest,
} from '@pertexo/node-sdk';
import {
  createInlineNodeRegistry,
  NodeExecutorFailure,
  type InlineNodeInvocation,
  type InlineNodeResult,
} from '@pertexo/node-sdk/server';
import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
  type InlineAdvanceOptions,
} from '../../../src/server.js';
import {
  graph,
  boundedPolicy,
  jsonataPolicy,
  manifest,
  nodeCatalog,
} from '../../support/executable-workflow.js';

const versionId = '00000000-0000-4000-8000-000000000101';
const occurredAt = '2026-11-21T10:00:00.000Z';
const fields = boundedNodeJsonRecordSchema;
const echo = {
  ...manifest('core.set', [boundedPolicy, jsonataPolicy]),
  definition: { key: 'core.set', version: 2 },
  executor: { key: 'core.set', version: 2 },
  execution: 'inline',
  configSchema: generateSchemaDocument(fields),
  inputSchema: generateSchemaDocument(fields),
  outputSchema: generateSchemaDocument(fields),
} as const satisfies NodeManifest;

async function start(
  count: number,
  kernel: (invocation: InlineNodeInvocation) => InlineNodeResult,
  options: Partial<InlineAdvanceOptions> = {},
  {
    withTerminate = true,
    expression,
    mixedFrontier,
  }: {
    withTerminate?: boolean;
    expression?: string;
    mixedFrontier?: true;
  } = {},
) {
  const template = graph();
  const manual = template.nodes[0];
  const terminate = template.nodes[2];
  const steps = Array.from({ length: count }, (_, offset) => {
    const nodeNumber = offset + 1;
    return {
      id: `step-${String(nodeNumber)}`,
      definition: echo.definition,
      position: { x: offset, y: 0 },
      configVersion: 1,
      config: { nodeNumber },
      inputMappings:
        offset === 0
          ? {
              prior:
                expression === undefined
                  ? { kind: 'run_input', path: '$.value' }
                  : { kind: 'expression', language: 'jsonata', expression },
            }
          : {
              prior: {
                kind: 'node_output',
                nodeId: `step-${String(offset)}`,
                path: '$.value',
              },
            },
      connectionRefs: {},
    } as const;
  });
  const last = steps.at(-1);
  if (last === undefined) throw new Error('Fixture chain missing');
  const nodes = [
    manual,
    ...steps,
    ...(withTerminate
      ? [
          {
            ...terminate,
            inputMappings: {
              result: { kind: 'node_output', nodeId: last.id, path: '$.value' },
            },
          },
        ]
      : []),
  ];
  const tail = nodes.slice(1);
  const external = {
    ...last,
    id: 'external',
    definition: { key: 'core.set', version: 1 },
    config: {},
    inputMappings: {},
  };
  const edges = tail.map<WorkflowEdge>(({ id }, index) => {
    const source = nodes[index];
    if (source === undefined) throw new Error('Fixture source missing');
    return {
      id: `edge-${String(index)}`,
      source: { nodeId: source.id, port: 'out' },
      target: { nodeId: id, port: 'in' },
    };
  });
  if (mixedFrontier)
    edges.push({
      id: 'manual-external',
      source: { nodeId: manual.id, port: 'out' },
      target: { nodeId: external.id, port: 'in' },
    });
  const original = nodeCatalog();
  const inlineCatalog = createNodeCatalog({
    definitions: [echo],
    executors: [executorManifestFor(echo)],
    policies: echo.policyReferences,
  });
  const catalog = createNodeCatalog({
    definitions: [...original.definitions, echo],
    executors: [...original.executors, executorManifestFor(echo)],
    policies: original.policies,
  });
  const executable = buildWorkflowExecutable({
    graph: {
      settings: template.settings,
      nodes: mixedFrontier ? [...nodes, external] : nodes,
      edges,
    },
    catalog: composeExecutableCatalog(catalog),
  });
  const base = {
    workflowVersionId: versionId,
    runId: 'inline-chain',
    executable,
    occurredAt,
    maximumAdmissions: 32,
    signal: new AbortController().signal,
  };
  const initial = await advanceWorkflow({
    ...base,
    checkpoint: createCheckpoint({
      workflowVersionId: versionId,
      iterationBudget: 0,
    }),
  });
  const [manualAttempt] = initial.attempts;
  if (manualAttempt === undefined)
    throw new Error('Manual attempt was not admitted');
  const registry = createInlineNodeRegistry({
    catalog: inlineCatalog,
    definitions: [],
    executors: [],
    core: {
      definitions: [
        {
          manifest: echo,
          configSchema: fields,
          inputSchema: fields,
          outputSchema: fields,
        },
      ],
      executors: [
        {
          executor: echo.executor,
          execute: ({ config, input }) =>
            Promise.resolve(
              kernel({
                config: fields.parse(config),
                input: fields.parse(input),
                now: Date.parse(occurredAt),
              }),
            ),
          executeInline: kernel,
        },
      ],
    },
  });
  const inline = {
    registry,
    readValues: () =>
      Promise.resolve({
        runInput: { value: 10 },
        outputs: [],
        attemptOutputs: [],
      }),
    newAttemptId: randomUUID,
    now: () => Date.parse(occurredAt),
    monotonicNow: () => 0,
    normalizeFailure: (error: unknown): never => {
      throw error;
    },
    ...options,
  };
  const attemptId = randomUUID();
  return {
    base,
    inline,
    checkpoint: initial.checkpoint,
    observations: [
      {
        kind: 'outcome',
        occurredAt,
        sequence: initial.checkpoint.nextEventSequence,
        attemptId,
        invocationKey: manualAttempt.invocationKey,
        attemptNumber: manualAttempt.attemptNumber,
        status: 'succeeded',
        output: { kind: 'inline', attemptId },
      },
    ],
  };
}

function add(invocation: InlineNodeInvocation): InlineNodeResult {
  const values = fields.parse(invocation.input);
  return { kind: 'succeeded', output: { value: Number(values.prior) + 1 } };
}

describe('bounded coordinator inline advances', () => {
  it('feeds settled values forward and enqueues only the final attempt frontier', async () => {
    const fixture = await start(3, (invocation) => {
      expect(Object.keys(invocation).sort()).toEqual([
        'config',
        'input',
        'now',
      ]);
      expect(invocation.now).toBe(Date.parse(occurredAt));
      return add(invocation);
    });
    const plan = await advanceWorkflow({
      ...fixture.base,
      checkpoint: fixture.checkpoint,
      observations: fixture.observations,
      inline: fixture.inline,
    });
    expect(
      plan.inlineAttempts?.map((attempt) =>
        attempt.kind === 'succeeded' ? attempt.output : attempt.kind,
      ),
    ).toEqual([{ value: 11 }, { value: 12 }, { value: 13 }]);
    expect(plan.attempts.map(({ nodeId }) => nodeId)).toEqual(['terminate']);
    expect(plan.checkpoint.revision).toBe(fixture.checkpoint.revision + 1);
    expect(
      plan.events.map(({ name, sequence }, index) => [name, sequence - index]),
    ).toEqual(
      [
        'node.ready',
        'node.started',
        'node.succeeded',
        'node.ready',
        'node.started',
        'node.succeeded',
        'node.ready',
        'node.started',
        'node.succeeded',
        'node.ready',
      ].map((name) => [name, fixture.checkpoint.nextEventSequence + 1]),
    );
    expect(plan.checkpoint.nextEventSequence).toBe(
      fixture.checkpoint.nextEventSequence + 1 + plan.events.length,
    );
  });

  it('leaves later inline siblings ready when the frontier needs a delivery', async () => {
    const fixture = await start(
      1,
      add,
      {},
      { withTerminate: false, mixedFrontier: true },
    );
    const delivery = await advanceWorkflow({
      ...fixture.base,
      checkpoint: fixture.checkpoint,
      observations: fixture.observations,
      inline: fixture.inline,
    });
    expect(delivery.inlineAttempts).toBeUndefined();
    expect(delivery.attempts.map(({ nodeId }) => nodeId)).toEqual(['external']);
    expect(delivery.checkpoint.invocations).toContainEqual(
      expect.objectContaining({
        nodeId: 'step-1',
        status: 'ready',
        attemptNumber: 0,
      }),
    );
    const [external] = delivery.attempts;
    if (external === undefined)
      throw new Error('Delivery-backed sibling is missing');
    const attemptId = randomUUID();
    const resumed = await advanceWorkflow({
      ...fixture.base,
      checkpoint: delivery.checkpoint,
      inline: fixture.inline,
      observations: [
        {
          kind: 'outcome',
          occurredAt,
          sequence: delivery.checkpoint.nextEventSequence,
          attemptId,
          invocationKey: external.invocationKey,
          attemptNumber: 1,
          status: 'succeeded',
          output: { kind: 'inline', attemptId },
        },
      ],
    });
    expect(resumed.inlineAttempts).toMatchObject([
      { nodeId: 'step-1', attemptNumber: 1, output: { value: 11 } },
    ]);
    expect(resumed.checkpoint.runStatus).toBe('succeeded');
  });

  it('yields at the attempt budget and continues from the committed predecessor', async () => {
    const fixture = await start(17, add, {}, { withTerminate: false });
    const first = await advanceWorkflow({
      ...fixture.base,
      checkpoint: fixture.checkpoint,
      observations: fixture.observations,
      inline: fixture.inline,
    });
    expect(first.inlineAttempts).toHaveLength(16);
    expect(first.immediateContinuation).toBe(true);
    expect(first.attempts).toEqual([]);
    const predecessor = first.inlineAttempts?.at(-1);
    if (predecessor?.kind !== 'succeeded')
      throw new Error('Predecessor did not finish');
    const second = await advanceWorkflow({
      ...fixture.base,
      checkpoint: first.checkpoint,
      inline: {
        ...fixture.inline,
        readValues: async (request) => ({
          ...(await fixture.inline.readValues(request)),
          outputs: [
            {
              nodeId: predecessor.nodeId,
              invocationKey: predecessor.invocationKey,
              value: predecessor.output,
            },
          ],
        }),
      },
    });
    expect(second.inlineAttempts).toMatchObject([
      { nodeId: 'step-17', output: { value: 27 } },
    ]);
    expect(second.attempts).toEqual([]);
    expect(second.checkpoint.runStatus).toBe('succeeded');
  });

  it('discards a late first kernel result and falls back to a delivery', async () => {
    let elapsed = 0;
    const fixture = await start(
      2,
      (invocation) => {
        elapsed += 51;
        return add(invocation);
      },
      {
        monotonicNow: () => elapsed,
      },
    );
    const plan = await advanceWorkflow({
      ...fixture.base,
      checkpoint: fixture.checkpoint,
      observations: fixture.observations,
      inline: fixture.inline,
    });
    expect(plan.inlineAttempts).toBeUndefined();
    expect(plan.attempts).toMatchObject([
      { nodeId: 'step-1', attemptNumber: 1 },
    ]);
    expect(plan.events.map(({ name }) => name)).toEqual(['node.ready']);
  });

  it('keeps only the settled prefix if a later kernel returns after the budget', async () => {
    let elapsed = 0;
    const fixture = await start(
      3,
      (invocation) => {
        elapsed += 26;
        return add(invocation);
      },
      {
        monotonicNow: () => elapsed,
      },
    );
    const plan = await advanceWorkflow({
      ...fixture.base,
      checkpoint: fixture.checkpoint,
      observations: fixture.observations,
      inline: fixture.inline,
    });
    expect(plan.inlineAttempts).toMatchObject([
      { nodeId: 'step-1', output: { value: 11 } },
    ]);
    expect(plan.attempts).toEqual([]);
    expect(plan.immediateContinuation).toBe(true);
    expect(plan.checkpoint.invocations).toContainEqual(
      expect.objectContaining({
        nodeId: 'step-2',
        status: 'ready',
        attemptNumber: 0,
      }),
    );
  });
  it('applies the retry policy and gives a due inline retry its own attempt number', async () => {
    let now = Date.parse(occurredAt);
    const fixture = await start(
      1,
      (invocation) =>
        invocation.now === Date.parse(occurredAt)
          ? {
              kind: 'failed',
              failure: {
                kind: 'retry',
                errorKind: 'timeout',
                safeErrorCode: 'execution.timeout',
              },
            }
          : add(invocation),
      {
        now: () => now,
        normalizeFailure(error) {
          if (!(error instanceof NodeExecutorFailure)) throw error;
          return {
            failureKind: error.kind,
            errorKind: error.errorKind,
            safeErrorCode: 'execution.timeout',
          };
        },
      },
      { withTerminate: false },
    );
    const first = await advanceWorkflow({
      ...fixture.base,
      checkpoint: fixture.checkpoint,
      observations: fixture.observations,
      inline: fixture.inline,
    });
    expect(first.inlineAttempts).toMatchObject([
      { kind: 'executor_failure', disposition: 'retry', attemptNumber: 1 },
    ]);
    expect(first.attempts).toEqual([]);
    const retry = first.inlineAttempts?.[0];
    if (retry?.kind !== 'executor_failure' || retry.disposition !== 'retry')
      throw new Error('No delayed retry');
    now = Date.parse(retry.dueAt);
    const next = await advanceWorkflow({
      ...fixture.base,
      occurredAt: retry.dueAt,
      checkpoint: first.checkpoint,
      inline: fixture.inline,
      observations: [
        {
          kind: 'due_at',
          invocationKey: retry.invocationKey,
          occurredAt: retry.dueAt,
        },
      ],
    });
    expect(next.inlineAttempts).toMatchObject([
      { kind: 'succeeded', attemptNumber: 2, output: { value: 11 } },
    ]);
    expect(next.checkpoint.runStatus).toBe('succeeded');
  });

  it('settles a run deadline crossed by a synchronous kernel as a timeout', async () => {
    let now = Date.parse(occurredAt);
    const fixture = await start(
      2,
      (invocation) => {
        now += 60;
        return add(invocation);
      },
      { now: () => now, deadlineAt: now + 30 },
    );
    const plan = await advanceWorkflow({
      ...fixture.base,
      checkpoint: fixture.checkpoint,
      observations: fixture.observations,
      inline: fixture.inline,
    });
    expect(plan.inlineAttempts).toMatchObject([
      {
        kind: 'timed_out',
        attemptNumber: 1,
        safeErrorCode: 'execution.deadline_exceeded',
      },
    ]);
    expect(plan.attempts).toEqual([]);
    expect(plan.checkpoint.runStatus).toBe('timed_out');
  });
  it('interrupts a pending mapped expression when the advance budget runs out', async () => {
    const fixture = await start(
      1,
      () => {
        throw new Error('Kernel ran before its expression completed');
      },
      {
        monotonicNow: () => performance.now(),
        expressionEvaluator: {
          evaluate({ signal }) {
            if (signal === undefined)
              throw new Error('Expression evaluation has no deadline signal');
            return new Promise((resolve) => {
              const interrupted = () => {
                resolve({
                  kind: 'error',
                  code: 'timed_out',
                  message: 'Evaluation stopped',
                });
              };
              if (signal.aborted) interrupted();
              else
                signal.addEventListener('abort', interrupted, { once: true });
            });
          },
        },
      },
      { expression: '$.input.value' },
    );
    const plan = await advanceWorkflow({
      ...fixture.base,
      checkpoint: fixture.checkpoint,
      observations: fixture.observations,
      inline: fixture.inline,
    });
    expect(plan.inlineAttempts).toBeUndefined();
    expect(plan.attempts).toMatchObject([
      { nodeId: 'step-1', attemptNumber: 1 },
    ]);
  });
});
