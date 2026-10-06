import type { NativeCoordinatorResultPreparationScope } from '@pertexo/database/execution';
import { CoordinatorValueWorkStoppedError } from './coordinator-handler.js';
import {
  createCoordinatorValueWorkLifetime,
  type CoordinatorValueWorkPolicy,
} from './coordinator-value-work-lifetime.js';

/** Same framework lifetime as demand, independently initialized for precommit. */
export function createCoordinatorResultPreparationScope(
  policy: CoordinatorValueWorkPolicy,
): NativeCoordinatorResultPreparationScope {
  const configured = Object.freeze({ ...policy });
  return async (input, prepare) => {
    const lifetime = createCoordinatorValueWorkLifetime({
      policy: configured,
      inspectOwner: input.inspectOwner,
    });
    const outcome = await lifetime.withValueWork(
      input.owner,
      input.signal,
      (session) => session.perform(prepare),
    );
    if (outcome.kind === 'stopped')
      throw new CoordinatorValueWorkStoppedError(outcome.stop);
    return outcome.value;
  };
}
