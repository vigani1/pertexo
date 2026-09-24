import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import {
  workflowGraphSchema,
  type WorkflowGraphContract,
} from '@pertexo/contracts/schemas/workflow-authoring';
import { describe, expect, it } from 'vitest';
import { projectWorkflowGraph } from '@/features/workflow-editor/model/graph-adapter';
import {
  addDefinitionNode,
  connectWorkflowNodes,
  moveWorkflowNode,
  removeWorkflowNode,
  updateWorkflowNode,
} from '@/features/workflow-editor/model/graph-commands';

import {
  parseNumberField,
  schemaFields,
} from '@/features/workflow-editor/model/inspector-draft';
import {
  directPredecessorOptions,
  inputKeySuggestions,
  inputMappingRowsFor,
  inputMappingSourceErrors,
  nodeUsesRunInputDirectly,
  validateInputMappingRows,
} from '@/features/workflow-editor/model/input-mappings';

const definition = {
  schemaVersion: 1,
  definition: { key: 'core.set', version: 1 },
  family: 'transform',
  configVersion: 1,
  configSchema: { type: 'object', properties: {} },
  inputSchema: {},
  outputSchema: {},
  ports: { inputs: ['in'], outputs: ['out'] },
  credentialRequirements: [],
  connectionRequirements: [],
  retryClass: 'safe',
  resourceClass: 'cpu',
  capabilities: [],
  lifecycle: 'active',
  available: true,
  publishable: true,
} satisfies NodeDefinitionCatalogItem;

function emptyGraph(): WorkflowGraphContract {
  return { schemaVersion: 1, nodes: [], edges: [], settings: {} };
}

describe('workflow editor input mapping rows', () => {
  it('round-trips editable and advanced mappings without flattening typed literals', () => {
    const mappings = {
      literal: { kind: 'literal', value: { count: 2, active: true } },
      run: { kind: 'run_input', path: "$.customers[0]['display-name']" },
      upstream: {
        kind: 'node_output',
        nodeId: 'source',
        path: '$.customer',
      },
      expression: {
        kind: 'expression',
        language: 'jsonata',
        expression: 'runInput.customer',
        policyVersion: 1,
      },
      structured: {
        kind: 'structured_input',
        port: 'item',
        path: '$.id',
      },
    } satisfies WorkflowGraphContract['nodes'][number]['inputMappings'];
    const sourceNode = addDefinitionNode(
      emptyGraph(),
      definition,
      { x: 0, y: 0 },
      'source',
    ).nodes[0];
    const targetNode = addDefinitionNode(
      emptyGraph(),
      definition,
      { x: 100, y: 0 },
      'target',
    ).nodes[0];
    if (sourceNode === undefined || targetNode === undefined)
      throw new Error('expected mapping test nodes');
    const graph: WorkflowGraphContract = {
      schemaVersion: 1,
      nodes: [
        sourceNode,
        {
          ...targetNode,
          inputMappings: mappings,
        },
      ],
      edges: [
        {
          id: 'source-target',
          source: { nodeId: 'source', port: 'out' },
          target: { nodeId: 'target', port: 'in' },
        },
      ],
      settings: {},
    };

    const result = validateInputMappingRows(
      inputMappingRowsFor(mappings),
      graph,
      'target',
    );
    expect(result.errors).toEqual({});
    expect(result.inputMappings).toEqual(mappings);
  });

  it('validates duplicates, paths and direct predecessors without losing special keys', () => {
    const source = addDefinitionNode(
      emptyGraph(),
      definition,
      { x: 0, y: 0 },
      'source',
    );
    const graph = addDefinitionNode(
      source,
      definition,
      { x: 100, y: 0 },
      'target',
    );
    const connected = connectWorkflowNodes(
      graph,
      {
        source: 'source',
        sourceHandle: 'out',
        target: 'target',
        targetHandle: 'in',
      },
      'source-target',
    );
    if (connected === null) throw new Error('expected connected graph');
    const valid = validateInputMappingRows(
      [
        {
          id: 'literal',
          destinationKey: '__proto__',
          kind: 'literal',
          literalJson: '[null, -2, {"active": true}]',
        },
        {
          id: 'run',
          destinationKey: 'customer.name',
          kind: 'run_input',
          path: "$.customers[0]['display-name']",
        },
        {
          id: 'upstream',
          destinationKey: 'source',
          kind: 'node_output',
          nodeId: 'source',
          path: '$',
        },
      ],
      connected,
      'target',
    );
    expect(valid.errors).toEqual({});
    expect(Object.hasOwn(valid.inputMappings ?? {}, '__proto__')).toBe(true);
    expect(valid.inputMappings?.['customer.name']).toEqual({
      kind: 'run_input',
      path: "$.customers[0]['display-name']",
    });
    if (valid.inputMappings === undefined)
      throw new Error('valid mappings were not produced');
    expect(
      workflowGraphSchema.safeParse(
        updateWorkflowNode(connected, 'target', {
          inputMappings: valid.inputMappings,
        }),
      ).success,
    ).toBe(true);

    const invalid = validateInputMappingRows(
      [
        {
          id: 'one',
          destinationKey: 'duplicate',
          kind: 'run_input',
          path: '$.*',
        },
        {
          id: 'two',
          destinationKey: 'duplicate',
          kind: 'node_output',
          nodeId: 'unconnected',
          path: '$',
        },
        {
          id: 'three',
          destinationKey: '',
          kind: 'literal',
          literalJson: '{',
        },
      ],
      connected,
      'target',
    );
    expect(invalid.inputMappings).toBeUndefined();
    expect(invalid.errors).toEqual({
      one: {
        destinationKey: 'Destination keys must be unique.',
        source: 'Use $, dot properties, array indexes, or quoted properties.',
      },
      two: {
        destinationKey: 'Destination keys must be unique.',
        source: 'The source must be a directly connected predecessor.',
      },
      three: {
        destinationKey: 'Destination key is required.',
        source: 'Literal value must be valid JSON.',
      },
    });
  });
});

describe('workflow editor mapping sources and fields', () => {
  it('derives only direct predecessor and schema suggestions and matches trigger identities', () => {
    const first = addDefinitionNode(
      emptyGraph(),
      definition,
      { x: 0, y: 0 },
      'source',
    );
    const second = addDefinitionNode(
      first,
      definition,
      { x: 100, y: 0 },
      'middle',
    );
    const third = addDefinitionNode(
      second,
      definition,
      { x: 200, y: 0 },
      'target',
    );
    const oneEdge = connectWorkflowNodes(
      third,
      {
        source: 'source',
        sourceHandle: 'out',
        target: 'middle',
        targetHandle: 'in',
      },
      'source-middle',
    );
    const connected = connectWorkflowNodes(
      oneEdge ?? third,
      {
        source: 'middle',
        sourceHandle: 'out',
        target: 'target',
        targetHandle: 'in',
      },
      'middle-target',
    );
    expect(directPredecessorOptions(connected ?? third, 'target')).toEqual([
      { nodeId: 'middle', label: 'Set fields' },
    ]);
    const renamed = updateWorkflowNode(connected ?? third, 'middle', {
      label: 'Renamed source',
    });
    expect(directPredecessorOptions(renamed, 'target')).toEqual([
      { nodeId: 'middle', label: 'Renamed source' },
    ]);
    const mappingRows = [
      {
        id: 'source-row',
        destinationKey: 'source',
        kind: 'node_output',
        nodeId: 'middle',
        path: '$',
      },
    ] as const;
    expect(inputMappingSourceErrors(mappingRows, renamed, 'target')).toEqual(
      {},
    );
    expect(
      inputMappingSourceErrors(
        mappingRows,
        { ...renamed, edges: renamed.edges.slice(0, -1) },
        'target',
      ),
    ).toEqual({
      'source-row': {
        source: 'The source must be a directly connected predecessor.',
      },
    });
    expect(
      inputKeySuggestions({
        type: 'object',
        properties: {
          customer: { type: 'string', title: 'Customer' },
          count: { type: 'number', description: 'Requested count' },
        },
        additionalProperties: true,
      }),
    ).toEqual([
      { key: 'customer', label: 'Customer', type: 'string' },
      {
        key: 'count',
        label: 'count',
        description: 'Requested count',
        type: 'number',
      },
    ]);
    expect(nodeUsesRunInputDirectly({ key: 'core.manual', version: 1 })).toBe(
      true,
    );
    expect(nodeUsesRunInputDirectly({ key: 'core.set', version: 1 })).toBe(
      false,
    );
  });

  it('parses number fields strictly, keeping partial text as an error', () => {
    const [optional, required] = schemaFields({
      type: 'object',
      required: ['requiredCount'],
      properties: {
        optionalCount: { type: 'number', title: 'Optional count' },
        requiredCount: { type: 'integer', minimum: 1, maximum: 10 },
      },
    });
    if (optional === undefined || required === undefined)
      throw new Error('expected two schema fields');
    expect(required).toMatchObject({
      label: 'Required count',
      required: true,
      minimum: 1,
      maximum: 10,
    });
    expect(parseNumberField(optional, '')).toEqual({
      ok: true,
      value: undefined,
    });
    expect(parseNumberField(optional, '-2.5')).toEqual({
      ok: true,
      value: -2.5,
    });
    expect(parseNumberField(optional, '-')).toEqual({
      ok: false,
      error: 'Optional count must be a number.',
    });
    expect(parseNumberField(required, '')).toEqual({
      ok: false,
      error: 'Required count is required.',
    });
    expect(parseNumberField(required, '1.5')).toEqual({
      ok: false,
      error: 'Required count must be a whole number.',
    });
    expect(parseNumberField(required, '11')).toEqual({
      ok: false,
      error: 'Required count can be at most 10.',
    });
  });
});

describe('workflow editor graph transitions', () => {
  it('projects unsupported nodes without mutating or dropping their contract data', () => {
    const graph = addDefinitionNode(
      emptyGraph(),
      definition,
      { x: 10, y: 20 },
      'node-a',
    );
    const unsupported = updateWorkflowNode(graph, 'node-a', {
      label: 'Retained node',
      config: { nested: { value: 1 } },
    });
    const projection = projectWorkflowGraph(unsupported, []);
    expect(projection.nodes[0]?.data.unsupported).toBe(true);
    expect(projection.nodes[0]?.data.label).toBe('Retained node');
    expect(unsupported.nodes[0]?.config).toEqual({ nested: { value: 1 } });
  });

  it('preserves graph identity for cheap no-op transitions', () => {
    const graph = addDefinitionNode(
      emptyGraph(),
      definition,
      { x: 12, y: 24 },
      'node-a',
    );
    expect(moveWorkflowNode(graph, 'node-a', { x: 12, y: 24 })).toBe(graph);
    expect(moveWorkflowNode(graph, 'missing', { x: 1, y: 2 })).toBe(graph);
    expect(updateWorkflowNode(graph, 'missing', { label: 'ignored' })).toBe(
      graph,
    );
    expect(removeWorkflowNode(graph, 'missing')).toBe(graph);
  });

  it('adds, connects and removes nodes as one domain graph', () => {
    const first = addDefinitionNode(
      emptyGraph(),
      definition,
      { x: 0, y: 0 },
      'a',
    );
    const second = addDefinitionNode(first, definition, { x: 100, y: 0 }, 'b');
    const connected = connectWorkflowNodes(
      second,
      { source: 'a', sourceHandle: 'out', target: 'b', targetHandle: 'in' },
      'edge-a-b',
    );
    expect(connected?.edges).toHaveLength(1);
    expect(removeWorkflowNode(connected ?? second, 'a')).toEqual({
      ...second,
      nodes: [second.nodes[1]],
      edges: [],
    });
  });
});
