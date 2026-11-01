import type { WorkflowGraphContract } from '@pertexo/contracts';
import type { JsonValue } from '@pertexo/workflow-model';
import { JsonataEvaluator } from '@pertexo/workflow-model/server';
import { fireEvent, screen } from '@testing-library/react';
import { afterAll } from 'vitest';
import {
  link,
  openEditor,
  pinHandler,
  step,
  type GraphNode,
} from '../../../../support/fixtures/inspector-session';

const evaluator = new JsonataEvaluator();
afterAll(() => evaluator.shutdown());

const SAMPLE = {
  status: 200,
  state: 'Paid',
  verified: true,
  customer: { name: 'Ada' },
};

export type Condition = GraphNode['inputMappings'][string];

export const asExpression = (expression: string): Condition => ({
  kind: 'expression',
  language: 'jsonata',
  expression,
});

export function orderGraph(
  condition?: Condition,
  extra: GraphNode['inputMappings'] = {},
): WorkflowGraphContract {
  return {
    nodes: [
      step('manual', 'core.manual', 'Start'),
      step('fetch', 'core.set', 'Fetch order'),
      step('check', 'core.condition', 'Check order', {
        inputMappings: {
          ...extra,
          ...(condition === undefined ? {} : { condition }),
        },
      }),
      step('after', 'core.set', 'After check'),
    ],
    edges: [
      link('manual', 'fetch'),
      link('fetch', 'check'),
      link('check', 'after', 'true'),
    ],
    settings: {},
  };
}

export function openCheck(
  graph: WorkflowGraphContract,
  options: Parameters<typeof openEditor>[1] = {},
) {
  return openEditor(graph, {
    handlers: [pinHandler('fetch', SAMPLE)],
    firstStep: 'Check order',
    ...options,
  });
}

export type Session = Awaited<ReturnType<typeof openCheck>>;

function nth<Element>(found: readonly Element[], index: number): Element {
  const element = found[index];
  if (element === undefined) throw new Error(`No rule ${String(index + 1)}`);
  return element;
}

export const fieldAt = (rule: number) =>
  nth(screen.getAllByLabelText('Field'), rule);
export const comparisonAt = (rule: number) =>
  nth(screen.getAllByLabelText('Comparison'), rule);
export const valueAt = (rule: number) =>
  nth(screen.getAllByLabelText<HTMLInputElement>('Value'), rule);

export async function pickField(session: Session, rule: number, name: RegExp) {
  await session.event.click(fieldAt(rule));
  await session.event.click(await screen.findByRole('button', { name }));
}

export function typeValue(rule: number, value: string) {
  fireEvent.change(valueAt(rule), { target: { value } });
}

export const noteText = /does more than rules can show/u;
export const NOT_VALID_YET = 'An edit isn’t valid yet, so it isn’t saved.';

/** What the stored condition answers in a real run of this output. */
export async function answer(stored: Condition | undefined, output: JsonValue) {
  if (stored?.kind !== 'expression')
    throw new Error('Rules store an expression');
  return evaluator.evaluate({
    expression: stored.expression,
    context: { runInput: {}, nodeOutputs: { fetch: output } },
  });
}

export const TWO_RULES =
  '($type(nodeOutputs."fetch"."status") = "number" and nodeOutputs."fetch"."status" >= 200) or ($lowercase($string(nodeOutputs."fetch"."customer"."name")) = $lowercase("ada"))';
