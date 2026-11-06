import { expect, it } from 'vitest';
import { parseCompletedOutputItems } from '../../src/observation/coordinator-output.js';

it('accepts a full 200-output completion frontier with near-inline-limit outputs', () => {
  const outputs = Array.from({ length: 200 }, (_, sequence) => ({
    sequence: sequence + 1,
    attemptId: '00000000-0000-4000-8000-000000000001',
    invocationKey: `version|node-${String(sequence)}|b:|i:`,
    value: { items: ['x'.repeat(260_000)], iterationCount: 1 },
  }));
  const parsed = parseCompletedOutputItems(outputs);
  expect(parsed).toHaveLength(200);
  expect(parsed[199]).toEqual(outputs[199]);
});

it('names the completion-count limit and the individual inline-output limit', () => {
  expect(() =>
    parseCompletedOutputItems(Array.from({ length: 201 }, () => null)),
  ).toThrow('Completed control output window exceeds 200 outputs.');
  expect(() =>
    parseCompletedOutputItems([{ value: 'x'.repeat(264_000) }]),
  ).toThrow(
    'A completed control output exceeds the stored inline-output limits. Reduce the step output.',
  );
});
