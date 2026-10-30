import jsonata from 'jsonata';

/**
 * One child process of the evaluator's pool. A user expression can make V8
 * abort its whole process on one oversized allocation, so it never runs in a
 * process that matters. No relative imports: tests start this file from source.
 */
type EvaluationMessage = Readonly<{
  expression: string;
  outputBytes: number;
  context: Readonly<{
    runInput: unknown;
    nodeOutputs: unknown;
    loop?: unknown;
    variables?: unknown;
    execution?: unknown;
  }>;
}>;

const FAILURE_MESSAGE_LENGTH = 512;

function copyJsonataValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyJsonataValue);
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of Object.keys(value))
      result[key] = copyJsonataValue(Reflect.get(value, key));
    return result;
  }
  return value;
}

function jsonOnly(_key: string, value: unknown): unknown {
  if (typeof value === 'function')
    throw new TypeError('The expression result is not JSON');
  return value;
}

/** Measured here, so an oversized result never reaches the host's memory. */
function resultMessage(value: unknown, outputBytes: number) {
  if (value === undefined) return { kind: 'missing' };
  const json = JSON.stringify(value, jsonOnly);
  return Buffer.byteLength(json) > outputBytes
    ? { kind: 'output_too_large' }
    : { kind: 'value', value };
}

async function evaluate(message: EvaluationMessage): Promise<void> {
  try {
    const input = copyJsonataValue({
      runInput: message.context.runInput,
      nodeOutputs: message.context.nodeOutputs,
      ...(message.context.loop === undefined
        ? {}
        : { loop: message.context.loop }),
    });
    process.send?.({ kind: 'started' });
    const value = (await jsonata(message.expression).evaluate(input, {
      vars: copyJsonataValue(message.context.variables ?? {}),
      execution: copyJsonataValue(message.context.execution ?? {}),
    })) as unknown;
    process.send?.(resultMessage(value, message.outputBytes));
  } catch (caught: unknown) {
    process.send?.({
      kind: 'failed',
      message:
        caught instanceof Error
          ? caught.message.slice(0, FAILURE_MESSAGE_LENGTH)
          : 'evaluation failed',
    });
  }
}

// The host is gone, so nobody can read a result or kill this process later.
process.once('disconnect', () => process.exit(0));
process.on('message', (message: EvaluationMessage) => {
  void evaluate(message);
});
process.send?.({ kind: 'ready' });
