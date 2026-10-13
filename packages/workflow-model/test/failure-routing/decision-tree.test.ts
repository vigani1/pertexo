import { describe, expect, it } from 'vitest';
import {
  inspectWorkflowDecisionTree,
  type DecisionTreeNode,
} from '../../src/failure-routing/decision-tree.js';
import type { WorkflowEdge } from '../../src/graph/contract.js';
const node = (id: string, key = 'core.set'): DecisionTreeNode => ({
  id,
  definition: { key, version: 1 },
});
const edge = (source: string, target: string, port = 'out'): WorkflowEdge => ({
  id: `${source}-${target}`,
  source: { nodeId: source, port },
  target: { nodeId: target, port: 'in' },
});
const root = node('entry', 'core.manual');
describe('one selected recovery path', () => {
  it('accepts nested Conditions and leaf Stop run while keeping both future branches', () => {
    const graph = {
      nodes: [
        root,
        node('first', 'core.condition'),
        node('second', 'core.condition'),
        node('a', 'core.terminate'),
        node('b', 'core.terminate'),
        node('c'),
      ],
      edges: [
        edge('entry', 'first'),
        edge('first', 'second', 'true'),
        edge('first', 'c', 'false'),
        edge('second', 'a', 'true'),
        edge('second', 'b', 'false'),
      ],
    };
    expect(
      inspectWorkflowDecisionTree(graph)?.outgoing.get('first'),
    ).toHaveLength(2);
  });
  it('supports skipped ordinary actions but refuses a disabled Condition with no saved choice', () => {
    expect(
      inspectWorkflowDecisionTree({
        nodes: [root, { ...node('action'), disabled: true }],
        edges: [edge('entry', 'action')],
      }),
    ).toBeDefined();
    expect(
      inspectWorkflowDecisionTree({
        nodes: [
          root,
          { ...node('condition', 'core.condition'), disabled: true },
        ],
        edges: [edge('entry', 'condition')],
      }),
    ).toBeUndefined();
  });
  it.each([
    'core.switch',
    'core.parallel',
    'core.merge',
    'core.foreach',
    'core.wait',
    'core.call',
  ])('refuses %s', (key) => {
    expect(
      inspectWorkflowDecisionTree({
        nodes: [root, node('control', key)],
        edges: [edge('entry', 'control')],
      }),
    ).toBeUndefined();
  });
  it('refuses ordinary fanout, joins, disconnected nodes, cycles and a non-leaf Stop run', () => {
    for (const graph of [
      {
        nodes: [root, node('a'), node('b')],
        edges: [edge('entry', 'a'), edge('entry', 'b')],
      },
      {
        nodes: [
          root,
          node('c', 'core.condition'),
          node('a'),
          node('b'),
          node('join'),
        ],
        edges: [
          edge('entry', 'c'),
          edge('c', 'a', 'true'),
          edge('c', 'b', 'false'),
          edge('a', 'join'),
          edge('b', 'join'),
        ],
      },
      { nodes: [root, node('orphan')], edges: [] },
      {
        nodes: [root, node('a')],
        edges: [edge('entry', 'a'), edge('a', 'entry')],
      },
      {
        nodes: [root, node('stop', 'core.terminate'), node('a')],
        edges: [edge('entry', 'stop'), edge('stop', 'a')],
      },
    ])
      expect(inspectWorkflowDecisionTree(graph)).toBeUndefined();
  });
  it('refuses duplicate or unknown Condition ports and repeated node identities', () => {
    for (const port of ['true', 'out'])
      expect(
        inspectWorkflowDecisionTree({
          nodes: [root, node('c', 'core.condition'), node('a'), node('b')],
          edges: [
            edge('entry', 'c'),
            edge('c', 'a', 'true'),
            edge('c', 'b', port),
          ],
        }),
      ).toBeUndefined();
    expect(
      inspectWorkflowDecisionTree({ nodes: [root, root], edges: [] }),
    ).toBeUndefined();
  });
});
