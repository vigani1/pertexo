import { describe, expect, it } from 'vitest';

import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
} from '../../../src/index.js';
import {
  nodeCatalog,
  pairedParallelGraph,
  switchGraph,
} from '../../support/executable-workflow.js';

// The fixture catalog's config schemas accept any object, so these cases
// check the engine's own reading of Switch, Parallel and Merge config.
const catalog = composeExecutableCatalog(
  nodeCatalog({ switch: true, parallel: true, merge: true }),
);
const refused = {
  name: 'WorkflowEngineError',
  code: 'executable_invalid',
} as const;

describe('control-node config the scheduler can run', () => {
  it('compiles Switch cases case-01 to case-16 and Parallel branches with a bounded concurrency', () => {
    expect(() =>
      buildWorkflowExecutable({
        graph: withSwitchCases([
          { id: 'case-01', equals: 1 },
          { id: 'case-16', equals: 2 },
        ]),
        catalog,
      }),
    ).not.toThrow();
    expect(() =>
      buildWorkflowExecutable({
        graph: withParallelConfig({
          branches: [{ id: 'branch-02' }, { id: 'branch-01' }],
          maxConcurrency: 2,
        }),
        catalog,
      }),
    ).not.toThrow();
  });

  it('refuses a Merge count above its paired Parallel branches', () => {
    expect(() =>
      buildWorkflowExecutable({
        graph: withMergeConfig({
          parallelNodeId: 'parallel',
          policy: { kind: 'count', count: 3 },
        }),
        catalog,
      }),
    ).toThrow(expect.objectContaining(refused));
  });

  // engine-05: compile accepts Switch case IDs the scheduler can't route.
  it.fails.each(['case-17', 'case-00', 'other'])(
    'refuses the Switch case ID %s at compile time',
    (id) => {
      expect(() =>
        buildWorkflowExecutable({
          graph: withSwitchCases([
            { id: 'case-01', equals: 1 },
            { id, equals: 2 },
          ]),
          catalog,
        }),
      ).toThrow(expect.objectContaining(refused));
    },
  );

  // engine-05: compile accepts a Parallel concurrency the scheduler ignores.
  it.fails.each([
    ['zero', 0],
    ['above the branch count', 3],
    ['missing', undefined],
  ])('refuses a Parallel concurrency that is %s', (_, maxConcurrency) => {
    expect(() =>
      buildWorkflowExecutable({
        graph: withParallelConfig({
          branches: [{ id: 'branch-02' }, { id: 'branch-01' }],
          ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
        }),
        catalog,
      }),
    ).toThrow(expect.objectContaining(refused));
  });

  // engine-05: compile accepts a Merge policy the scheduler can't settle.
  it.fails.each([
    ['unknown', { parallelNodeId: 'parallel', policy: { kind: 'some' } }],
    ['missing', { parallelNodeId: 'parallel' }],
  ])('refuses a Merge policy that is %s', (_, config) => {
    expect(() =>
      buildWorkflowExecutable({ graph: withMergeConfig(config), catalog }),
    ).toThrow(expect.objectContaining(refused));
  });
});

function withSwitchCases(cases: readonly unknown[]) {
  const graph = switchGraph('case-01');
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === 'switch' ? { ...node, config: { cases } } : node,
    ),
  };
}

function withParallelConfig(config: Readonly<Record<string, unknown>>) {
  const graph = pairedParallelGraph();
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === 'parallel' ? { ...node, config } : node,
    ),
  };
}

function withMergeConfig(config: Readonly<Record<string, unknown>>) {
  const graph = pairedParallelGraph();
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === 'merge' ? { ...node, config } : node,
    ),
  };
}
