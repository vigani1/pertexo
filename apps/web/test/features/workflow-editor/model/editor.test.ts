import {
  addDefinitionNode,
  linkWorkflowNodes,
  updateWorkflowNode,
} from '@/features/workflow-editor/model/graph/commands';

import {
  changeInputMappingKind,
  inputMappingRowsFor,
  inputMappingSourceErrors,
  validateInputMappingRows,
} from '@/features/workflow-editor/model/inspector/input-mappings/draft';

import {
  workflowGraphSchema,
  type WorkflowGraphContract,
} from '@pertexo/contracts';

import { describe, expect, it } from 'vitest';

import { bareSetDefinition as definition } from '../../../support/fixtures/workflow-editor';

import { emptyGraph, loopRow } from './editor/fixture';

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
    const connected = linkWorkflowNodes(
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
        destinationKey: 'Another input already uses this field.',
        source: 'Use $, dot properties, array indexes, or quoted properties.',
      },
      two: {
        destinationKey: 'Another input already uses this field.',
        source: 'The source must be a directly linked predecessor.',
      },
      three: {
        destinationKey: 'Destination key is required.',
        source: 'Literal value must be valid JSON.',
      },
    });
  });
});

describe('loop item sources inside a For each body', () => {
  it('reads the item or its position only where a body offers them', () => {
    const level = addDefinitionNode(
      emptyGraph(),
      definition,
      { x: 0, y: 0 },
      'step',
    );
    const loopPorts = ['item', 'ordinal'];
    expect(
      validateInputMappingRows([loopRow('item')], level, 'step', { loopPorts })
        .inputMappings,
    ).toEqual({
      order: { kind: 'structured_input', port: 'item', path: '$.id' },
    });
    expect(
      validateInputMappingRows([loopRow('batch')], level, 'step', { loopPorts })
        .errors,
    ).toEqual({
      loop: {
        source:
          'Only steps inside a For each body can read the loop item. Choose another source.',
      },
    });
    // Live editing keeps such a row, shown as a warning, outside a body too.
    expect(
      validateInputMappingRows([loopRow('item')], level, 'step', {
        checkGraph: false,
        loopPorts: [],
      }).errors,
    ).toEqual({});
    expect(
      Object.keys(
        inputMappingSourceErrors([loopRow('item')], level, 'step', []),
      ),
    ).toEqual(['loop']);
    expect(
      changeInputMappingKind(
        { id: 'r', destinationKey: 'k', kind: 'literal', literalJson: '1' },
        'structured_input',
      ),
    ).toEqual({
      id: 'r',
      destinationKey: 'k',
      kind: 'structured_input',
      port: 'item',
      path: '$',
    });
  });
});
