import { projectWorkflowGraph } from '@/features/workflow-editor/model/graph/adapter';

import {
  addDefinitionNode,
  linkWorkflowNodes,
  moveWorkflowNode,
  updateWorkflowNode,
} from '@/features/workflow-editor/model/graph/commands';

import { removeWorkflowNode } from '@/features/workflow-editor/model/graph/removal';

import {
  parseNumberField,
  schemaFields,
} from '@/features/workflow-editor/model/inspector/draft';

import {
  directPredecessorOptions,
  inputMappingSourceErrors,
  nodeUsesRunInputDirectly,
} from '@/features/workflow-editor/model/inspector/input-mappings/draft';

import { inputKeySuggestions } from '@/features/workflow-editor/model/inspector/input-mappings/schema';

import { describe, expect, it } from 'vitest';

import { bareSetDefinition as definition } from '../../../../support/fixtures/workflow-editor';

import { emptyGraph } from './fixture';

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
    const oneEdge = linkWorkflowNodes(
      third,
      {
        source: 'source',
        sourceHandle: 'out',
        target: 'middle',
        targetHandle: 'in',
      },
      'source-middle',
    );
    const connected = linkWorkflowNodes(
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
        source: 'The source must be a directly linked predecessor.',
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
    expect(nodeUsesRunInputDirectly({ key: 'core.form', version: 1 })).toBe(
      true,
    );
    expect(
      nodeUsesRunInputDirectly({ key: 'core.workflow_error', version: 1 }),
    ).toBe(true);
    expect(nodeUsesRunInputDirectly({ key: 'core.form', version: 99 })).toBe(
      false,
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
    const connected = linkWorkflowNodes(
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
