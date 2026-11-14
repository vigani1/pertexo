import { describe, expect, it } from 'vitest';
import { projectExpressionContext } from '../../../src/values/expressions/expression-policy.js';
import { ExpressionContextInvalidError } from '../../../src/values/expressions/expression.errors.js';

describe('expression context projection', () => {
  it.each([
    null,
    'text',
    {},
    { runInput: {} },
    { runInput: {}, nodeOutputs: [] },
    { runInput: {}, nodeOutputs: {}, loop: 'x' },
    { runInput: {}, nodeOutputs: {}, execution: { callbacks: { a: {} } } },
  ])('refuses a malformed context %j with its named error', (context) => {
    expect(() => projectExpressionContext(context)).toThrow(
      ExpressionContextInvalidError,
    );
  });

  it('keeps the message the evaluator reports', () => {
    expect(() => projectExpressionContext({})).toThrow(
      'invalid expression context',
    );
  });
});
