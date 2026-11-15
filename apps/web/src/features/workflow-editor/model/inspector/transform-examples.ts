import type { JsonValue } from '@pertexo/workflow-model';

export interface ExpressionExample {
  readonly id: string;
  readonly name: string;
  readonly expression: string;
  readonly input: JsonValue;
  readonly result: JsonValue;
}

/** Static examples only; actual step tests use the production restricted evaluator. */
export const expressionExamples: readonly ExpressionExample[] = [
  {
    id: 'trim',
    name: 'Trim whitespace',
    expression: '$trim(runInput.text)',
    input: { text: '  Hello  ' },
    result: 'Hello',
  },
  {
    id: 'uppercase',
    name: 'Uppercase text',
    expression: '$uppercase(runInput.text)',
    input: { text: 'Hello' },
    result: 'HELLO',
  },
  {
    id: 'lowercase',
    name: 'Lowercase text',
    expression: '$lowercase(runInput.text)',
    input: { text: 'Hello' },
    result: 'hello',
  },
  {
    id: 'join',
    name: 'Join text items',
    expression: '$join(runInput.items, ", ")',
    input: { items: ['Ada', 'Lin'] },
    result: 'Ada, Lin',
  },
  {
    id: 'number',
    name: 'Convert text to a number',
    expression: '$number(runInput.text)',
    input: { text: '42.5' },
    result: 42.5,
  },
];
