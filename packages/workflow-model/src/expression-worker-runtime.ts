import { parentPort } from 'node:worker_threads';

import jsonata from 'jsonata';

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
port.once(
  'message',
  async (message: Readonly<{ expression: string; context: unknown }>) => {
    try {
      const input = copyJsonataValue(message.context);
      port.postMessage({ started: true });
      const value = await jsonata(message.expression).evaluate(input);
      port.postMessage({
        ok: true,
        missing: value === undefined,
        value: copyJsonataValue(value),
      });
    } catch (caught: unknown) {
      port.postMessage({
        ok: false,
        message: caught instanceof Error ? caught.message : 'evaluation failed',
      });
    }
  },
);
