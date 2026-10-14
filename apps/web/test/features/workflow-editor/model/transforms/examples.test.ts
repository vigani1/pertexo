// @vitest-environment node
import { afterAll, describe, expect, it } from 'vitest';
import { JsonataEvaluator } from '@pertexo/workflow-model/server';
import { expressionExamples } from '@/features/workflow-editor/model/inspector/transforms/examples';

const evaluator = new JsonataEvaluator();
afterAll(() => evaluator.shutdown());
describe('expression examples through the production evaluator', () => {
  it.each(expressionExamples)(
    'keeps $name syntax and example output valid',
    async (example) => {
      expect(
        await evaluator.evaluate({
          expression: example.expression,
          context: { runInput: example.input, nodeOutputs: {} },
        }),
      ).toMatchObject({ kind: 'value', value: example.result });
    },
  );
  it.each(expressionExamples)(
    'does not invent a value when $name input is missing',
    async (example) => {
      expect(
        await evaluator.evaluate({
          expression: example.expression,
          context: { runInput: {}, nodeOutputs: {} },
        }),
      ).toEqual({ kind: 'missing' });
    },
  );
  it.each(expressionExamples)(
    'reports null and wrong types for $name',
    async (example) => {
      const key = example.id === 'join' ? 'items' : 'text';
      for (const value of [null, {}])
        expect(
          await evaluator.evaluate({
            expression: example.expression,
            context: { runInput: { [key]: value }, nodeOutputs: {} },
          }),
        ).toMatchObject({ kind: 'error', code: 'evaluation_failed' });
    },
  );
});
