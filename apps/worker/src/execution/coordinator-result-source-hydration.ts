import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { boundedNodeJsonSchema } from '@pertexo/node-sdk';
import type { JsonValue } from '@pertexo/workflow-model/canonical-json';
import type {
  CoordinatorRunStore,
  NativeCoordinatorResultSourceHydrator,
} from '@pertexo/database/execution';
import { CallableCompletionStoppedError } from '@pertexo/workflow-engine';
import { loadSelectedCoordinatorMaterial } from './coordinator-selected-material.js';
import type { CoordinatorNativeValueWork } from './coordinator-native-demand-advance.js';

function active(signal: AbortSignal): void {
  if (signal.aborted)
    throw new DOMException(
      'Native result source hydration aborted',
      'AbortError',
    );
}

/** Shared read/codec mechanics only. The caller owns the independent precommit S.
 * No first-pass material or context is accepted, and no nested lifetime is created.
 */
export function createCoordinatorResultSourceHydration(
  runStore: CoordinatorRunStore,
  valueWork: CoordinatorNativeValueWork,
): NativeCoordinatorResultSourceHydrator {
  return async ({ owner, demand, signal }) => {
    active(signal);
    const result = await loadSelectedCoordinatorMaterial({
      owner,
      demand,
      runStore,
      valueWork,
      session: {
        signal,
        perform: async <T>(
          work: (borrowed: AbortSignal) => Promise<T>,
        ): Promise<T> => {
          active(signal);
          const value = await work(signal);
          active(signal);
          return value;
        },
      },
    });
    active(signal);
    if (result.kind === 'stopped')
      throw new CallableCompletionStoppedError(result.stop);
    if (result.kind === 'invalid_context') return undefined;
    const outputs = z
      .array(
        z
          .object({
            invocationKey: z.string(),
            output: z.unknown(),
            value: boundedNodeJsonSchema,
          })
          .strict(),
      )
      .max(1000)
      .parse(result.material.outputs);
    if (outputs.length !== demand.sources.length)
      throw new TypeError('Native result source inventory differs');
    const nodeOutputs: Record<string, JsonValue> = Object.create(
      null,
    ) as Record<string, JsonValue>;
    for (const [index, expected] of demand.sources.entries()) {
      const output = outputs[index];
      if (
        output?.invocationKey !== expected.invocationKey ||
        !isDeepStrictEqual(output.output, expected.output) ||
        Object.hasOwn(nodeOutputs, expected.nodeId)
      )
        throw new TypeError('Native result selected output identity differs');
      nodeOutputs[expected.nodeId] = output.value;
    }
    return {
      runInput: boundedNodeJsonSchema.parse(result.material.runInput),
      nodeOutputs,
    };
  };
}
