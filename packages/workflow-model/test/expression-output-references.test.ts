import type jsonata from 'jsonata';
import { describe, expect, it, vi } from 'vitest';
import {
  EXPRESSION_POLICY_V1,
  inspectExpressionNodeOutputReferences,
  validateExpression,
} from '../src/expressions.js';

vi.mock('jsonata', async (importOriginal) => {
  const { default: parse } = await importOriginal<{
    default: typeof jsonata;
  }>();
  return {
    default: (source: string) => {
      const expression = parse(source);
      if (source === '"unsupported dependency AST fixture"') {
        // Admission accepts this node type, but inspection must not silently
        // claim no dependencies for a representation it cannot interpret.
        Object.defineProperty(expression, 'ast', {
          value: () => ({
            type: 'operator',
            value: '?',
            rhs: { type: 'name', value: 'nodeOutputs' },
          }),
        });
      }
      return expression;
    },
  };
});

describe('restricted expression root output dependencies', () => {
  it.each([
    ['42', []],
    ['"nodeOutputs.a"', []],
    ['runInput.nodeOutputs.a', []],
    ['$lookup(runInput, "nodeOutputs")', []],
    ['$keys(runInput)', []],
    ['runInput.(nodeOutputs.a)', []],
    ['nodeOutputs.a', ['a']],
    ['$.nodeOutputs.a.value', ['a']],
    ['nodeOutputs.`a-b`.value', ['a-b']],
    ['nodeOutputs.a.nodeOutputs.b', ['a']],
    ['nodeOutputs.a.(nodeOutputs.b)', ['a']],
    ['nodeOutputs.a[runInput.key].value', ['a']],
    ['nodeOutputs.a[$.nodeOutputs.b]', ['a']],
    ['nodeOutputs[true].a', ['a']],
    ['$lookup(nodeOutputs, "a")', ['a']],
    ['$lookup($, "nodeOutputs").a', ['a']],
    ['$lookup(nodeOutputs.a, "b")', ['a']],
    ['(nodeOutputs).a', ['a']],
    ['(runInput; nodeOutputs).a', ['a']],
    ['(runInput.flag ? nodeOutputs : runInput).a', ['a']],
    ['{"x":nodeOutputs.b,"y":[nodeOutputs.a,nodeOutputs.b]}', ['a', 'b']],
    ['$sum(nodeOutputs.a.values) + $count(nodeOutputs.b)', ['a', 'b']],
  ])(
    'inspects %s without introducing unrelated root outputs',
    (source, nodeIds) => {
      expect(inspectExpressionNodeOutputReferences(source, 1)).toEqual({
        kind: 'valid',
        nodeIds,
      });
    },
  );

  it.each([
    '$',
    'nodeOutputs',
    '$.nodeOutputs',
    'nodeOutputs.*',
    '*',
    '$lookup(nodeOutputs,runInput.key)',
    '$keys(nodeOutputs)',
    '$spread(nodeOutputs)',
    '$string($)',
    '$keys()',
    'nodeOutputs[$keys($)]',
    '(nodeOutputs; 1)',
  ])('requires all root outputs for whole/dynamic access: %s', (source) => {
    expect(inspectExpressionNodeOutputReferences(source, 1)).toEqual({
      kind: 'valid',
      nodeIds: 'all',
    });
  });

  it.each([
    '(',
    '$eval("1")',
    'nodeOutputs.**',
    '$x := nodeOutputs',
    'nodeOutputs.a.%',
  ])('preserves existing admission failure for %s', (source) => {
    expect(inspectExpressionNodeOutputReferences(source, 1)).toEqual(
      validateExpression(source, 1),
    );
  });

  it('preserves unsupported policy and source/AST bounds', () => {
    for (const [source, policy] of [
      ['nodeOutputs.a', 2],
      ['1'.repeat(EXPRESSION_POLICY_V1.expressionBytes + 1), 1],
      ['('.repeat(70) + 'nodeOutputs.a' + ')'.repeat(70), 1],
    ] as const) {
      expect(inspectExpressionNodeOutputReferences(source, policy)).toEqual(
        validateExpression(source, policy),
      );
    }
  });

  it('freezes independently returned deterministic references', () => {
    const result = inspectExpressionNodeOutputReferences(
      'nodeOutputs.z & nodeOutputs.a',
      1,
    );
    expect(result).toEqual({ kind: 'valid', nodeIds: ['a', 'z'] });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.kind !== 'valid') throw new Error('invalid fixture');
    expect(Object.isFrozen(result.nodeIds)).toBe(true);
  });

  it('fails closed when an admitted parser representation cannot be inspected', () => {
    const source = '"unsupported dependency AST fixture"';
    expect(validateExpression(source, 1)).toEqual({ kind: 'valid' });
    expect(inspectExpressionNodeOutputReferences(source, 1)).toEqual({
      kind: 'error',
      code: 'invalid_expression',
      message: 'expression dependencies could not be inspected',
    });
  });
});
