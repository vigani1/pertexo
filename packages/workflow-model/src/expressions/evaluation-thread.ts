import { parentPort } from 'node:worker_threads';

import jsonata from 'jsonata';
import type { ExpressionRequest } from './policy.js';
type EvaluationMessage = Pick<ExpressionRequest, 'expression' | 'context'>;

function copyJsonataValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyJsonataValue);
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of Object.keys(value).sort())
      result[key] = copyJsonataValue(Reflect.get(value, key));
    return result;
  }
  return value;
}

const port = parentPort;
if (port === null) throw new Error('expression worker requires a parent port');

port.postMessage({ ready: true });
async function evaluateExpression(
  message: EvaluationMessage,
  targetPort: NonNullable<typeof parentPort>,
): Promise<void> {
  try {
    const input = copyJsonataValue({
      runInput: message.context.runInput,
      nodeOutputs: message.context.nodeOutputs,
    });
    targetPort.postMessage({ started: true });
    const value = (await jsonata(message.expression).evaluate(input, {
      vars: copyJsonataValue(message.context.variables ?? {}),
    })) as unknown;
    targetPort.postMessage({
      ok: true,
      missing: value === undefined,
      value: copyJsonataValue(value),
    });
  } catch (caught: unknown) {
    targetPort.postMessage({
      ok: false,
      message: caught instanceof Error ? caught.message : 'evaluation failed',
    });
  }
}

port.once('message', (message: EvaluationMessage) => {
  void evaluateExpression(message, port);
});
