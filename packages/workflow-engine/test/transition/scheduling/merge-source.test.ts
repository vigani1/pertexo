import { expect, it } from 'vitest';
import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
  invocationKey,
  type InvocationState,
} from '../../../src/index.js';
import { executionNodes } from '../../../src/compilation/foundation.js';
import { mergeCoordinatorObservations } from '../../../src/observation/coordinator.js';
import {
  nodeCatalog,
  pairedParallelGraph,
} from '../../support/executable-workflow.js';

it('waits for a branch source to materialize before permanently recording its arrival', () => {
  const graph = pairedParallelGraph();
  const left = graph.nodes.find((node) => node.id === 'left');
  if (left === undefined) throw new Error('Missing fixture branch');
  const compiled = buildWorkflowExecutable({
    graph: {
      ...graph,
      nodes: [...graph.nodes, { ...left, id: 'before-left' }],
      edges: [
        ...graph.edges.map((edge) =>
          edge.id === 'parallel-left'
            ? { ...edge, target: { nodeId: 'before-left', port: 'in' } }
            : edge,
        ),
        {
          id: 'before-left-left',
          source: { nodeId: 'before-left', port: 'out' },
          target: { nodeId: 'left', port: 'in' },
        },
      ],
    },
    catalog: composeExecutableCatalog(
      nodeCatalog({ parallel: true, merge: true }),
    ),
  });
  const checkpoint = createCheckpoint({
    iterationBudget: 100,
    workflowVersionId: '00000000-0000-4000-8000-000000000601',
  });
  const path = [{ nodeId: 'parallel', outputPort: 'branch-01' }];
  const succeeded = (nodeId: string, scoped: boolean): InvocationState => ({
    nodeId,
    invocationKey: invocationKey({
      workflowVersionId: checkpoint.workflowVersionId,
      nodeId,
      branchPath: scoped ? ['parallel:branch-01'] : [],
    }),
    status: 'succeeded',
    attemptNumber: 1,
    ...(scoped ? { branchPath: path } : {}),
    output: {
      kind: 'inline',
      attemptId: '00000000-0000-4000-8000-000000000602',
    },
  });
  const nodes = new Map(
    executionNodes(compiled).map((node) => [node.id, node]),
  );
  const before = {
    ...checkpoint,
    invocations: [succeeded('parallel', false), succeeded('before-left', true)],
  };
  expect(
    mergeCoordinatorObservations(compiled, before, [], nodes).filter(
      (fact) => fact.kind === 'branch_disposition',
    ),
  ).toEqual([]);
  const source = succeeded('left', true);
  expect(
    mergeCoordinatorObservations(
      compiled,
      { ...before, invocations: [...before.invocations, source] },
      [],
      nodes,
    ),
  ).toContainEqual(
    expect.objectContaining({
      kind: 'branch_disposition',
      branch: {
        branchId: 'branch-01',
        disposition: 'arrived',
        output: source.output,
      },
    }),
  );
});
