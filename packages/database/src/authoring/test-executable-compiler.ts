import { createHash } from 'node:crypto';

import { canonicalJson, type WorkflowGraph } from '@pertexo/workflow-model';

import type { WorkflowExecutableCompiler } from './workflows/types.js';

const byId = (left: { id: string }, right: { id: string }): number =>
  left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

/** The graph without presentation: positions, labels and list order. */
function executableShape(graph: WorkflowGraph): unknown {
  return {
    ...graph,
    nodes: [...graph.nodes]
      .sort(byId)
      .map(({ position: _position, label: _label, ...node }) =>
        node.structured === undefined
          ? node
          : {
              ...node,
              structured: {
                ...node.structured,
                body: executableShape(node.structured.body),
              },
            },
      ),
    edges: [...graph.edges].sort(byId),
  };
}

/**
 * Publishes the graph itself as an opaque executable, for tests that publish
 * without the engine. Like the engine's, its checksum ignores presentation,
 * so republishing a relabeled graph reuses the version.
 */
export const testExecutableCompiler: WorkflowExecutableCompiler = (graph) => ({
  checksum: `wf:sha256:${createHash('sha256')
    .update(canonicalJson(executableShape(graph)))
    .digest('hex')}`,
  executableJson: { graph },
});
