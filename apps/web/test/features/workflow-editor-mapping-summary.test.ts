import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { describe, expect, it } from 'vitest';
import { addDefinitionNode } from '@/features/workflow-editor/model/graph-commands';
import { describeMappingSource } from '@/features/workflow-editor/model/mapping-summary';
import { bareSetDefinition as definition } from '../support/workflow-editor-fixtures';

function emptyGraph(): WorkflowGraphContract {
  return { schemaVersion: 1, nodes: [], edges: [], settings: {} };
}

describe('input mapping summaries', () => {
  const level = {
    nodes: [
      {
        ...addDefinitionNode(
          emptyGraph(),
          definition,
          { x: 0, y: 0 },
          'invoice',
        ).nodes[0],
        id: 'invoice',
        label: 'New invoice',
      },
    ],
    edges: [],
  } as unknown as WorkflowGraphContract;
  const row = { id: 'r', destinationKey: 'amount' } as const;

  it('names where each kind of source reads from, without the $ root', () => {
    expect(
      describeMappingSource(
        {
          ...row,
          kind: 'node_output',
          nodeId: 'invoice',
          path: '$.body.amount',
        },
        level,
      ),
    ).toEqual({ tone: 'reference', label: 'New invoice › body.amount' });
    expect(
      describeMappingSource(
        { ...row, kind: 'node_output', nodeId: 'invoice', path: '$' },
        level,
      ).label,
    ).toBe('New invoice');
    expect(
      describeMappingSource(
        { ...row, kind: 'node_output', nodeId: 'gone', path: '$' },
        level,
      ),
    ).toEqual({ tone: 'missing', label: 'A missing step' });
    expect(
      describeMappingSource(
        { ...row, kind: 'node_output', nodeId: '', path: '$' },
        level,
      ).tone,
    ).toBe('missing');
    expect(
      describeMappingSource(
        { ...row, kind: 'run_input', path: "$['display-name']" },
        level,
      ).label,
    ).toBe("Run input › ['display-name']");
    expect(
      describeMappingSource(
        { ...row, kind: 'structured_input', port: 'item', path: '$.id' },
        level,
      ).label,
    ).toBe('This item › id');
    expect(
      describeMappingSource(
        { ...row, kind: 'structured_input', port: 'ordinal', path: '$' },
        level,
      ).label,
    ).toBe('Its position');
    expect(
      describeMappingSource(
        {
          ...row,
          kind: 'expression',
          expression: 'body.amount > 5000',
          policyVersion: 1,
        },
        level,
      ),
    ).toEqual({
      tone: 'code',
      label: 'ƒ expression',
      code: 'body.amount > 5000',
    });
  });

  it('reads fixed values the way they look, and flags unfinished ones', () => {
    const literal = (literalJson: string) =>
      describeMappingSource({ ...row, kind: 'literal', literalJson }, level);
    expect(literal('"Paid"')).toEqual({ tone: 'value', label: '“Paid”' });
    expect(literal('1240')).toEqual({ tone: 'value', label: '1240' });
    // null, what a new row holds, reads as words rather than a token.
    expect(literal('null').label).toBe('no value');
    expect(literal('{"a":1,"b":2}').label).toBe('{2 fields}');
    expect(literal('[1]').label).toBe('[1 item]');
    expect(literal(JSON.stringify('x'.repeat(60))).label).toHaveLength(42);
    expect(literal('{')).toEqual({
      tone: 'missing',
      label: 'Unfinished value',
    });
  });
});
