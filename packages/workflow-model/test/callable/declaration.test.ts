import { describe, expect, it } from 'vitest';
import {
  parseWorkflowGraphDraft,
  safeParseWorkflowGraphDraft,
  validateWorkflowGraph,
  workflowGraphSchema,
  type CallableDeclaration,
  type WorkflowGraph,
} from '../../src/index.js';
import { validateAuthoringBatch } from '../../src/authoring-validation/validation.js';

const callable: CallableDeclaration = {
  input: { type: 'string' },
  resultType: { type: 'string' },
  result: { kind: 'run_input', path: '$' },
};
function graph(entry = 'core.manual'): WorkflowGraph {
  return {
    nodes: [
      {
        id: 'entry',
        definition: { key: entry, version: 1 },
        position: { x: 0, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
      },
    ],
    edges: [],
    settings: {},
    callable,
  };
}

describe('callable graph declarations', () => {
  it.each(['core.manual', 'core.webhook'])(
    'roundtrips an ordinary %s entry',
    (entry) => {
      const value = graph(entry);
      expect(parseWorkflowGraphDraft(value)).toEqual(value);
      expect(workflowGraphSchema.parse(value)).toEqual(value);
      expect(validateWorkflowGraph(value).ok).toBe(true);
    },
  );

  it('rejects a schedule or disabled entry and multiple entries', () => {
    for (const value of [
      graph('core.schedule'),
      {
        ...graph(),
        nodes: graph().nodes.map((node) => ({ ...node, disabled: true })),
      },
      {
        ...graph(),
        nodes: [
          ...graph().nodes,
          ...graph().nodes.map((node) => ({ ...node, id: 'second' })),
        ],
      },
      { ...graph(), nodes: [] },
    ]) {
      const report = validateWorkflowGraph(value);
      expect(report.ok).toBe(false);
      expect(report.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: '$.callable' }),
        ]),
      );
    }
  });

  it('rejects duplicate properties, dangling result nodes, body ports and invalid paths', () => {
    const invalid: CallableDeclaration[] = [
      {
        ...callable,
        input: {
          type: 'object',
          properties: [
            { name: 'id', valueType: { type: 'string' }, required: true },
            { name: 'id', valueType: { type: 'number' }, required: true },
          ],
        },
      },
      {
        ...callable,
        result: { kind: 'node_output', nodeId: 'absent', path: '$' },
      },
      { ...callable, result: { kind: 'run_input', path: '$..all' } },
      {
        ...callable,
        result: { kind: 'structured_input', port: 'item', path: '$' },
      },
    ];
    for (const declaration of invalid)
      expect(
        validateWorkflowGraph({ ...graph(), callable: declaration }).ok,
      ).toBe(false);
  });

  it('preserves own prototype-like keys in a literal result', () => {
    const value = {
      ...graph(),
      callable: {
        ...callable,
        result: {
          kind: 'literal' as const,
          value: JSON.parse('{"__proto__":"result","constructor":1}') as Record<
            string,
            string | number
          >,
        },
      },
    };
    expect(
      JSON.stringify(parseWorkflowGraphDraft(value).callable?.result),
    ).toBe(JSON.stringify(value.callable.result));
    expect(
      JSON.stringify(workflowGraphSchema.parse(value).callable?.result),
    ).toBe(JSON.stringify(value.callable.result));
  });

  it('bounds literal results and hostile declaration input before recursive parsing', () => {
    let value: unknown = null;
    for (let depth = 0; depth < 65; depth += 1) value = [value];
    expect(
      safeParseWorkflowGraphDraft({
        ...graph(),
        callable: { ...callable, result: { kind: 'literal', value } },
      }).success,
    ).toBe(false);
    let type: unknown = { type: 'null' };
    for (let depth = 0; depth < 500; depth += 1)
      type = { type: 'array', maxItems: 1, items: type };
    expect(() =>
      workflowGraphSchema.safeParse({
        ...graph(),
        callable: { ...callable, input: type },
      }),
    ).not.toThrow();
    expect(
      safeParseWorkflowGraphDraft({
        ...graph(),
        callable: { ...callable, input: type },
      }).success,
    ).toBe(false);
    let invoked = false;
    const hostile = {
      ...graph(),
      callable: {
        ...callable,
        get input() {
          invoked = true;
          throw new Error('secret');
        },
      },
    };
    expect(safeParseWorkflowGraphDraft(hostile).success).toBe(false);
    expect(invoked).toBe(false);
  });

  it('validates result expressions with the existing restricted JSONata policy', () => {
    const valid = {
      ...graph(),
      callable: {
        ...callable,
        result: {
          kind: 'expression' as const,
          language: 'jsonata' as const,
          expression: '$string(runInput)',
        },
      },
    };
    expect(validateAuthoringBatch(valid, { definitions: [] }).ok).toBe(true);
    const invalid = {
      ...valid,
      callable: {
        ...valid.callable,
        result: { ...valid.callable.result, expression: 'function($x){$x}' },
      },
    };
    expect(validateAuthoringBatch(invalid, { definitions: [] })).toMatchObject({
      ok: false,
      issues: [{ code: 'invalid_expression', path: '$.callable.result' }],
    });
  });
});
