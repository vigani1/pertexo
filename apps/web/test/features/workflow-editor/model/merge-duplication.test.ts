// Test-only admission proof against built public packages; never browser imports.
import { PLATFORM_NODE_CATALOG } from '../../../../../../packages/node-catalog/dist/index.js';
import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
} from '../../../../../../packages/workflow-engine/dist/index.js';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import { describe, expect, it } from 'vitest';
import { duplicateWorkflowNodes } from '@/features/workflow-editor/model/graph/copies';
import { createEditorStore } from '@/features/workflow-editor/model/state/store';
import { loopStep, step } from '../../../support/fixtures/for-each';
import { etagA } from '../../../support/fixtures/workflow-editor';

const catalog = composeExecutableCatalog(PLATFORM_NODE_CATALOG);
const groupIds = ['parallel', 'left', 'right', 'merge'];

function parallelGroup() {
  return {
    nodes: [
      {
        ...step('parallel', 'Parallel'),
        definition: { key: 'core.parallel', version: 1 },
        configVersion: 1,
        config: {
          branches: [{ id: 'branch-01' }, { id: 'branch-02' }],
          maxConcurrency: 1,
        },
      },
      step('left', 'Left'),
      step('right', 'Right'),
      {
        ...step('merge', 'Merge'),
        definition: { key: 'core.merge', version: 1 },
        configVersion: 1,
        config: { parallelNodeId: 'parallel', policy: { kind: 'all' } },
      },
    ],
    edges: [
      edge('p-l', 'parallel', 'left', 'branch-01'),
      edge('p-r', 'parallel', 'right', 'branch-02'),
      edge('l-m', 'left', 'merge', 'out', 'branch-01'),
      edge('r-m', 'right', 'merge', 'out', 'branch-02'),
    ],
  };
}

function edge(
  id: string,
  source: string,
  target: string,
  output = 'out',
  input = 'in',
) {
  return {
    id,
    source: { nodeId: source, port: output },
    target: { nodeId: target, port: input },
  };
}

function graph(nested: boolean): WorkflowGraphContract {
  const group = parallelGroup();
  const start = {
    ...step('start', 'Start'),
    definition: { key: 'core.manual', version: 1 },
  };
  const end = {
    ...step('end', 'End'),
    definition: { key: 'core.terminate', version: 1 },
  };
  return {
    schemaVersion: 1,
    settings: {},
    nodes: nested
      ? [start, smallLoop(loopStep('loop', 'Loop', group)), end]
      : [start, ...group.nodes, end],
    edges: nested
      ? [edge('start-loop', 'start', 'loop'), edge('loop-end', 'loop', 'end')]
      : [
          edge('start-p', 'start', 'parallel'),
          ...group.edges,
          edge('m-end', 'merge', 'end'),
        ],
  };
}

/** Few enough items that the duplicated body stays within the invocation limit. */
function smallLoop(loop: ReturnType<typeof loopStep>) {
  const { structured } = loop;
  if (structured === undefined) throw new Error('For each fixture missing');
  return { ...loop, structured: { ...structured, maxIterations: 20 } };
}

function admit(graph: WorkflowGraphContract) {
  return buildWorkflowExecutable({ graph, catalog });
}

describe('duplicating a paired Parallel/Merge group', () => {
  for (const nested of [false, true]) {
    it(`remaps ${nested ? 'a body' : 'the root'} and admits both complete groups`, () => {
      const original = graph(nested);
      expect(() => admit(original)).not.toThrow();
      let sequence = 0;
      const result = duplicateWorkflowNodes(
        original,
        groupIds,
        () => `copy-${String(++sequence)}`,
      );
      const copied = nested
        ? result.graph.nodes[1]?.structured?.body
        : result.graph;
      const parallel = copied?.nodes.find(
        (node) => node.id === result.nodeIds[0],
      );
      const merge = copied?.nodes.find((node) => node.id === result.nodeIds[3]);
      expect(merge?.config.parallelNodeId).toBe(parallel?.id);
      expect(merge?.definition.version).toBe(1);
      expect(merge?.config.policy).toEqual({ kind: 'all' });
      if (parallel === undefined || merge === undefined || copied === undefined)
        throw new Error('Copied group is missing');
      const connected = {
        ...copied,
        edges: [
          ...copied.edges.filter((item) => item.id !== 'm-end'),
          edge('between-groups', 'merge', parallel.id),
          ...(nested ? [] : [edge('copy-end', merge.id, 'end')]),
        ],
      };
      const finalGraph = nested
        ? {
            ...result.graph,
            nodes: result.graph.nodes.map((node) =>
              node.structured === undefined
                ? node
                : {
                    ...node,
                    structured: {
                      ...node.structured,
                      body: { ...node.structured.body, ...connected },
                    },
                  },
            ),
          }
        : { ...result.graph, edges: connected.edges };
      expect(() => admit(finalGraph)).not.toThrow();
      const store = createEditorStore({
        graph: original,
        etag: etagA,
        revision: 1,
      });
      store.getState().transact(finalGraph);
      store.getState().undo();
      expect(store.getState().graph).toEqual(original);
      store.getState().redo();
      expect(store.getState().graph).toEqual(finalGraph);
    });
  }

  it('remaps inside a copied body, preserves unknown config and leaves a merge-only reference alone', () => {
    const original = graph(true);
    const result = duplicateWorkflowNodes(original, ['loop']);
    const body = result.graph.nodes.at(-1)?.structured?.body;
    const parallel = body?.nodes.find(
      (node) => node.definition.key === 'core.parallel',
    );
    expect(
      body?.nodes.find((node) => node.definition.key === 'core.merge')?.config
        .parallelNodeId,
    ).toBe(parallel?.id);
    const root = graph(false);
    const extended = {
      ...root,
      nodes: root.nodes.map((node) =>
        node.id === 'merge'
          ? { ...node, config: { ...node.config, future: { retained: true } } }
          : node,
      ),
    };
    const solo = duplicateWorkflowNodes(extended, ['merge']);
    expect(solo.graph.nodes.at(-1)?.config).toEqual(
      extended.nodes.find((node) => node.id === 'merge')?.config,
    );
    const together = duplicateWorkflowNodes(extended, groupIds);
    expect(together.graph.nodes.at(-1)?.config.future).toEqual({
      retained: true,
    });
  });

  it('does not rewrite opaque, unknown-version or invalid references', () => {
    const original = graph(false);
    for (const override of [
      { definition: { key: 'future.merge', version: 3 } },
      { definition: { key: 'core.merge', version: 99 } },
      { config: { parallelNodeId: 42 } },
      { config: { parallelNodeId: 'left' } },
    ]) {
      const altered = {
        ...original,
        nodes: original.nodes.map((node) =>
          node.id === 'merge' ? { ...node, ...override } : node,
        ),
      };
      const result = duplicateWorkflowNodes(altered, groupIds);
      expect(result.graph.nodes.at(-1)?.config).toEqual(
        altered.nodes.find((node) => node.id === 'merge')?.config,
      );
    }
  });
});
