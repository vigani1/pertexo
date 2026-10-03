import { describe, expect, it } from 'vitest';
import { parseCallableResultSourceText } from '@/features/workflow-editor/model/inspector/callable-result-source';

describe('callable result source text', () => {
  it.each([
    { kind: 'literal', value: {} },
    { kind: 'run_input', path: '$' },
    { kind: 'node_output', nodeId: 'result', path: '$' },
    {
      kind: 'expression',
      language: 'jsonata',
      expression: '$',
      policyVersion: 1,
    },
  ])('preserves a shared value source: $kind', (source) => {
    expect(parseCallableResultSourceText(JSON.stringify(source))).toEqual({
      ok: true,
      value: source,
    });
  });
  it('preserves own literal data keys through shared admission', () => {
    const text =
      '{"kind":"literal","value":{"__proto__":{"x":1},"nested":[{"constructor":2}]}}';
    expect(parseCallableResultSourceText(text)).toEqual({
      ok: true,
      value: JSON.parse(text) as unknown,
    });
  });
  it.each([
    '{',
    'null',
    '{}',
    '{"kind":"node_output","path":"$"}',
    '{"kind":"literal","value":{},"extra":true}',
  ])('keeps invalid text out of the applied graph: %s', (text) => {
    expect(parseCallableResultSourceText(text).ok).toBe(false);
  });
});
