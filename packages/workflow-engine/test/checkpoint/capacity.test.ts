import { randomUUID } from 'node:crypto';

import {
  validateWorkflowGraph,
  WORKFLOW_GRAPH_CONTRACT_LIMITS,
  WORKFLOW_GRAPH_LIMITS,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import { describe, expect, it } from 'vitest';

import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
  WORKFLOW_CHECKPOINT_LIMITS,
} from '../../src/index.js';
import {
  forEachGraph,
  graph as chainGraph,
  nestedForEachGraph,
  nodeCatalog,
} from '../support/executable-workflow.js';

// Live invocations repeat node IDs in their keys. Serial cases also prove that
// finished scopes do not accumulate between maximum-sized declarations.
const { identifierLength } = WORKFLOW_GRAPH_CONTRACT_LIMITS;
const limit = WORKFLOW_GRAPH_LIMITS.maxExpandedInvocations;
const occurredAt = '2026-10-09T12:00:00.000Z';

const longId = (name: string) => name.padEnd(identifierLength, '-');

/** Renames every node to a maximum-length ID. */
function withLongIds(graph: unknown, names: readonly string[]): WorkflowGraph {
  let json = JSON.stringify(graph);
  for (const name of names)
    json = json.split(`"${name}"`).join(`"${longId(name)}"`);
  return JSON.parse(json) as WorkflowGraph;
}

function loopGraph(
  iterations: number,
  concurrency = iterations,
): WorkflowGraph {
  const graph = structuredClone(forEachGraph());
  const loop = graph.nodes.find(({ id }) => id === 'loop');
  if (loop === undefined || !('structured' in loop))
    throw new Error('For Each fixture missing');
  const [item] = loop.structured.body.nodes;
  if (item === undefined) throw new Error('For Each body missing');
  Object.assign(loop.structured, {
    maxIterations: iterations,
    maxConcurrency: concurrency,
    body: { ...loop.structured.body, nodes: [item], edges: [] },
  });
  return withLongIds(graph, ['manual', 'loop', 'body-first', 'terminate']);
}

function nestedLoopGraph(
  outer: number,
  inner: number,
  serial = false,
): WorkflowGraph {
  const graph = nestedForEachGraph();
  const loop = graph.nodes.find(({ id }) => id === 'loop');
  if (loop === undefined || !('structured' in loop))
    throw new Error('outer For Each fixture missing');
  const innerLoop = loop.structured.body.nodes.find(
    ({ id }) => id === 'body-first',
  );
  if (innerLoop === undefined || !('structured' in innerLoop))
    throw new Error('inner For Each fixture missing');
  Object.assign(loop.structured, {
    maxIterations: outer,
    maxConcurrency: serial ? 1 : outer,
  });
  // nestedForEachGraph adds the inner structure after the fixture is typed.
  Object.assign(innerLoop.structured as object, {
    maxIterations: inner,
    maxConcurrency: serial ? 1 : inner,
  });
  return withLongIds(graph, [
    'manual',
    'loop',
    'body-first',
    'body-sink',
    'nested-body',
    'terminate',
  ]);
}

function flatGraph(nodes: number): WorkflowGraph {
  const [manual, set, terminate] = chainGraph().nodes;
  const ids = Array.from({ length: nodes }, (_, index) =>
    longId(`node-${String(index)}`),
  );
  return {
    settings: { maxRunDurationMs: 60_000 },
    nodes: ids.map((id, index) =>
      index === 0
        ? { ...manual, id }
        : index === nodes - 1
          ? {
              ...terminate,
              id,
              inputMappings: {
                result: {
                  kind: 'node_output',
                  nodeId: ids[index - 1],
                  path: '$',
                },
              },
            }
          : { ...set, id, inputMappings: {} },
    ),
    edges: ids.slice(1).map((id, index) => ({
      id: `edge-${String(index)}`,
      source: { nodeId: ids[index], port: 'out' },
      target: { nodeId: id, port: 'in' },
    })),
  } as WorkflowGraph;
}

/** Runs the workflow to completion and returns its largest checkpoint. */
async function runToCompletion(
  graph: WorkflowGraph,
  loopItems: Readonly<Record<string, number>>,
  maximumValues = false,
  outOfOrder = false,
): Promise<{
  status: string;
  checkpointBytes: number;
  retainedIterationInvocations: number;
}> {
  const workflowVersionId = randomUUID();
  const executable = buildWorkflowExecutable({
    graph,
    catalog: composeExecutableCatalog(nodeCatalog({ forEach: true })),
  });
  const base = {
    runId: 'checkpoint-capacity',
    executable,
    workflowVersionId,
    occurredAt,
    maximumAdmissions: 64,
    signal: new AbortController().signal,
  };
  let plan = await advanceWorkflow({
    ...base,
    checkpoint: createCheckpoint({
      workflowVersionId,
      iterationBudget: WORKFLOW_GRAPH_LIMITS.maxTotalLoopIterations,
    }),
    observations: [],
  });
  let checkpointBytes = 0;
  let held: (typeof plan.attempts)[number] | undefined;
  let holdFirst = outOfOrder;
  for (;;) {
    checkpointBytes = Math.max(
      checkpointBytes,
      Buffer.byteLength(JSON.stringify(plan.checkpoint)),
    );
    if (
      plan.attempts.length === 0 &&
      !plan.immediateContinuation &&
      held === undefined
    )
      return {
        status: plan.checkpoint.runStatus,
        checkpointBytes,
        retainedIterationInvocations: plan.checkpoint.invocations.filter(
          ({ iterationPath }) => (iterationPath?.length ?? 0) > 0,
        ).length,
      };
    let sequence = plan.checkpoint.nextEventSequence;
    const observations = [];
    const completedOutputs = [];
    const attempts = [...plan.attempts];
    if (
      plan.attempts.length === 0 &&
      !plan.immediateContinuation &&
      held !== undefined
    ) {
      attempts.push(held);
      held = undefined;
    }
    for (const attempt of attempts) {
      if (holdFirst && attempt.iterationPath?.[0]?.ordinal === 0) {
        held = attempt;
        holdFirst = false;
        continue;
      }
      const attemptId = randomUUID();
      const items = loopItems[attempt.nodeId];
      observations.push({
        kind: 'outcome',
        sequence,
        occurredAt,
        invocationKey: attempt.invocationKey,
        attemptId,
        attemptNumber: attempt.attemptNumber,
        status: 'succeeded',
        output: { kind: 'inline', attemptId },
      });
      completedOutputs.push({
        sequence,
        attemptId,
        invocationKey: attempt.invocationKey,
        value:
          items === undefined
            ? { done: true }
            : {
                items: Array.from({ length: items }, (_, index) =>
                  maximumValues
                    ? 'x'.repeat(Math.floor((256 * 1_024 - 128) / items) - 3)
                    : index,
                ),
                iterationCount: items,
              },
      });
      sequence += 1;
    }
    plan = await advanceWorkflow({
      ...base,
      checkpoint: plan.checkpoint,
      observations,
      completedOutputs,
    });
  }
}

describe('checkpoint capacity at the authoring limits', () => {
  it.each([
    {
      name: 'a For Each',
      graph: loopGraph(limit - 3),
      loopItems: { [longId('loop')]: limit - 3 },
      expanded: limit,
      maximumValues: false,
    },
    {
      // Trigger, terminate and outer loop, plus 14 × (inner loop, 12 items, sink).
      name: 'nested For Each loops',
      graph: nestedLoopGraph(14, 12),
      loopItems: { [longId('loop')]: 14, [longId('body-first')]: 12 },
      expanded: limit - 1,
      maximumValues: false,
    },
    {
      name: 'a chain of nodes',
      graph: flatGraph(limit),
      loopItems: {},
      expanded: limit,
      maximumValues: false,
    },
    {
      name: 'a serial For Each with maximum stored values',
      graph: loopGraph(limit - 3, 1),
      loopItems: { [longId('loop')]: limit - 3 },
      expanded: limit,
      maximumValues: true,
    },
    {
      name: 'serial nested loops with maximum stored values',
      graph: nestedLoopGraph(14, 12, true),
      loopItems: { [longId('loop')]: 14, [longId('body-first')]: 12 },
      expanded: limit - 1,
      maximumValues: true,
    },
    {
      name: 'an out-of-order For Each with maximum stored values',
      graph: loopGraph(limit - 3, 2),
      loopItems: { [longId('loop')]: limit - 3 },
      expanded: limit,
      maximumValues: true,
      outOfOrder: true,
    },
  ])(
    'runs $name at the invocation limit with maximum-length IDs',
    async ({ graph, loopItems, expanded, maximumValues, outOfOrder }) => {
      expect(validateWorkflowGraph(graph)).toMatchObject({
        ok: true,
        expandedInvocations: expanded,
      });

      const { status, checkpointBytes, retainedIterationInvocations } =
        await runToCompletion(graph, loopItems, maximumValues, outOfOrder);

      expect(status).toBe('succeeded');
      expect(retainedIterationInvocations).toBe(0);
      if (maximumValues) expect(checkpointBytes).toBeLessThan(8 * 1_024);
      // Headroom for later checkpoint fields before authoring must shrink.
      expect(checkpointBytes).toBeLessThan(
        WORKFLOW_CHECKPOINT_LIMITS.bytes * 0.9,
      );
    },
  );

  it('rejects one invocation over the limit when authoring', () => {
    expect(validateWorkflowGraph(loopGraph(limit - 2))).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: 'expansion_limit' })],
    });
  });
});
