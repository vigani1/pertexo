import jsonata from 'jsonata';
import { expect, it } from 'vitest';
import { workflowGraphSchema } from '@pertexo/contracts';
import { duplicateWorkflowNodes } from '@/features/workflow-editor/model/graph/copies';

it.each([
  'nodeOutputs."source"."amount"',
  '$lookup(nodeOutputs,"source").amount',
])(
  'calculates copied %s references while preserving literal text and unrelated references',
  async (reference) => {
    let next = 0;
    const copied = duplicateWorkflowNodes(
      expressionChain(reference),
      ['source', 'consumer'],
      () => `copy-${String(++next)}`,
    );
    const source = copied.graph.nodes.find(
      (node) => node.id === copied.nodeIds[1],
    )?.inputMappings.amount;
    if (source?.kind !== 'expression')
      throw new Error('Expected the copied expression');
    expect(
      await jsonata(source.expression).evaluate({
        nodeOutputs: {
          source: { amount: 1 },
          'copy-1': { amount: 100 },
          unrelated: { amount: 7 },
        },
      }),
    ).toEqual({ amount: 200, literal: 'nodeOutputs.source', other: 7 });
  },
);

it('calculates references inside a copied For each from its copied body steps', async () => {
  const chain = expressionChain('nodeOutputs."source"."amount"');
  const graph = workflowGraphSchema.parse({
    nodes: [
      {
        id: 'loop',
        definition: { key: 'core.foreach', version: 1 },
        configVersion: 1,
        position: { x: 0, y: 0 },
        config: {},
        inputMappings: {},
        connectionRefs: {},
        structured: {
          kind: 'for_each',
          maxIterations: 5,
          maxConcurrency: 1,
          body: {
            ...chain,
            inputPorts: ['item', 'ordinal'],
            outputPorts: ['result'],
          },
        },
      },
    ],
    edges: [],
    settings: {},
  });
  let next = 0;
  const copied = duplicateWorkflowNodes(
    graph,
    ['loop'],
    () => `copy-${String(++next)}`,
  );
  const body = copied.graph.nodes.find((node) => node.id === copied.nodeIds[0])
    ?.structured?.body;
  const source = body?.nodes.find((node) => node.label === 'Source');
  const expression = body?.nodes.find((node) => node.label === 'Consumer')
    ?.inputMappings.amount;
  if (source === undefined || expression?.kind !== 'expression')
    throw new Error('Expected copied body steps');
  expect(
    await jsonata(expression.expression).evaluate({
      nodeOutputs: {
        source: { amount: 1 },
        [source.id]: { amount: 100 },
        unrelated: { amount: 7 },
      },
    }),
  ).toEqual({ amount: 200, literal: 'nodeOutputs.source', other: 7 });
});

function expressionChain(reference: string) {
  const step = (id: string, label: string) => ({
    id,
    label,
    definition: { key: 'core.set', version: 1 },
    configVersion: 1,
    position: { x: 0, y: 0 },
    config: {},
    inputMappings: {},
    connectionRefs: {},
  });
  return workflowGraphSchema.parse({
    nodes: [
      step('source', 'Source'),
      {
        ...step('consumer', 'Consumer'),
        inputMappings: {
          amount: {
            kind: 'expression',
            language: 'jsonata',
            expression: `{"amount": ${reference} * 2, "literal": "nodeOutputs.source", "other": nodeOutputs."unrelated"."amount"}`,
          },
        },
      },
    ],
    edges: [
      {
        id: 'link',
        source: { nodeId: 'source', port: 'out' },
        target: { nodeId: 'consumer', port: 'in' },
      },
    ],
    settings: {},
  });
}
