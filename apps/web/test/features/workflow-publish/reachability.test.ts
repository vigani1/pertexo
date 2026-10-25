import { expect, it } from 'vitest';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import { unreachableStepIssues } from '@/features/workflow-publish/model/validation/reachability';
import { workflowIssuesView } from '@/features/workflow-publish/model/validation/issues-state';
import { workflowTestStepLabels } from '@/features/workflow-publish/model/testing/workflow';

function node(id: string, key = 'core.code') {
  return {
    id,
    definition: { key, version: 1 },
    configVersion: 1,
    position: { x: 0, y: 0 },
    config: {},
    inputMappings: {},
    connectionRefs: {},
  };
}
const graph: WorkflowGraphContract = {
  nodes: [
    node('start', 'core.manual'),
    node('code'),
    { ...node('orphan'), label: 'Read file' },
  ],
  edges: [
    {
      id: 'link',
      source: { nodeId: 'start', port: 'out' },
      target: { nodeId: 'code', port: 'in' },
    },
  ],
  settings: {},
};
it('uses canvas names while preserving labels in test history', () => {
  expect([...workflowTestStepLabels(graph).values()]).toEqual([
    'Manual start',
    'Code',
    'Read file',
  ]);
});
it('warns about unconnected steps without blocking publication', () => {
  expect(unreachableStepIssues(graph)).toEqual([
    {
      id: 'unreachable-orphan',
      message: "Read file isn't linked from a trigger, so it never runs.",
      target: { nodeId: 'orphan' },
    },
  ]);
  const view = workflowIssuesView(
    {
      validation: undefined,
      validationPending: false,
      validationError: undefined,
    },
    graph,
    { generation: 0, revision: 1 },
  );
  expect(view.groups?.[0]?.nodeId).toBe('orphan');
  expect(view.countsByNode.has('orphan')).toBe(false);
  expect(view.blockingGroups).toEqual([]);
});
it('follows failure links and leaves disconnected cycles unreachable', () => {
  const linked = {
    ...graph,
    edges: [
      ...graph.edges,
      {
        id: 'failure',
        source: { nodeId: 'code', port: 'failure' },
        target: { nodeId: 'orphan', port: 'in' },
      },
    ],
  };
  expect(unreachableStepIssues(linked)).toEqual([]);
  expect(
    unreachableStepIssues({
      ...graph,
      edges: [
        {
          id: 'cycle',
          source: { nodeId: 'code', port: 'out' },
          target: { nodeId: 'code', port: 'in' },
        },
      ],
    }),
  ).toHaveLength(2);
});

it('includes nested steps only when their For each is reachable', () => {
  const loop = {
    ...node('loop', 'core.foreach'),
    structured: {
      kind: 'for_each' as const,
      maxIterations: 10,
      maxConcurrency: 1,
      body: {
        nodes: [node('body')],
        edges: [],
        settings: {},
        inputPorts: ['item', 'ordinal'],
        outputPorts: ['result'],
      },
    },
  };
  const nested: WorkflowGraphContract = {
    nodes: [node('start', 'core.manual'), loop],
    edges: [],
    settings: {},
  };
  expect(
    unreachableStepIssues(nested).map((issue) => issue.target?.nodeId),
  ).toEqual(['loop', 'body']);
  expect(
    unreachableStepIssues({
      ...nested,
      edges: [
        {
          id: 'into-loop',
          source: { nodeId: 'start', port: 'out' },
          target: { nodeId: 'loop', port: 'in' },
        },
      ],
    }),
  ).toEqual([]);
  expect(workflowTestStepLabels(nested).get('body')).toBe('Code');
});
