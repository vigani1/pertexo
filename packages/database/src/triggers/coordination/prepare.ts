import {
  canonicalJson,
  normalizeJson,
  type EventCoordinationPolicy,
} from '@pertexo/workflow-model';
import {
  JsonataEvaluator,
  resolveEventCoordinationKey,
} from '@pertexo/workflow-model/server';
import { createHash } from 'node:crypto';
import { serializeWrittenJsonValue } from '../../platform/stored-execution-value.js';
import type { PreparedEventCoordination } from './contract.js';
import { EventCoordinationUnavailableError } from './errors.js';
/** Each ingress store owns a bounded, lazy expression pool and releases it on close. */
export function createEventCoordinationPreparation() {
  const evaluator = new JsonataEvaluator();
  return {
    close: () => evaluator.shutdown(),
    async prepare(
      policy: EventCoordinationPolicy | undefined,
      input: unknown,
      signal?: AbortSignal,
    ): Promise<PreparedEventCoordination | undefined> {
      if (policy === undefined) return undefined;
      const inputJson = serializeWrittenJsonValue(input);
      const key = await resolveEventCoordinationKey(
        policy,
        normalizeJson(JSON.parse(inputJson)),
        evaluator,
        signal,
      );
      if (key.kind === 'unavailable')
        throw new EventCoordinationUnavailableError();
      return {
        policy,
        inputJson,
        policyHash: createHash('sha256')
          .update(canonicalJson(policy))
          .digest('hex'),
        keyHash:
          key.kind === 'key'
            ? createHash('sha256').update(key.canonical).digest('hex')
            : null,
      };
    },
  };
}

export async function closeEventCoordinationStore(
  closeDatabase: () => Promise<void>,
  preparation: ReturnType<typeof createEventCoordinationPreparation>,
): Promise<void> {
  const outcomes = await Promise.allSettled([
    closeDatabase(),
    preparation.close(),
  ]);
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason as unknown] : [],
  );
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      'Trigger event preparation and database shutdown failed',
    );
}
