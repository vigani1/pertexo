import { afterAll } from 'vitest';

import { JsonataEvaluator } from '@pertexo/workflow-model/server';
import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
} from '../../../src/index.js';
import { graph, nodeCatalog } from '../executable-workflow.js';
export const expressionEvaluator = new JsonataEvaluator();
afterAll(async () => expressionEvaluator.shutdown());
export function mappedExecutable() {
  const mappedGraph = structuredClone(graph());
  Object.assign(mappedGraph.nodes[1], {
    inputMappings: {
      literal: { kind: 'literal', value: null },
      fromRun: { kind: 'run_input', path: '$.name' },
      fromNode: {
        kind: 'node_output',
        nodeId: 'manual',
        path: '$.base',
      },
      missing: { kind: 'run_input', path: '$.absent' },
      expression: {
        kind: 'expression',
        language: 'jsonata',
        expression: 'runInput.count + nodeOutputs.manual.base',
      },
    },
  });
  return buildWorkflowExecutable({
    graph: mappedGraph,
    catalog: composeExecutableCatalog(nodeCatalog()),
  });
}
