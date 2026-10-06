import {
  parseCoordinatorControlDeclarationInventory,
  type CoordinatorRunStore,
  type NativeCoordinatorValueOwner,
  type NativeCoordinatorControlDeclarationIdentity,
} from '@pertexo/database/execution';
import {
  CallableCompletionStoppedError,
  type LoadCoordinatorControlDeclaration,
} from '@pertexo/workflow-engine';
import type { CoordinatorValueWorkSession } from './coordinator-value-work-lifetime.js';
import type { createCoordinatorControlSourceHydration } from './coordinator-control-source-hydration.js';

/** One metadata inventory; every selected source still rechecks current authority. */
export function createCoordinatorControlDeclarationLoader(
  input: Readonly<{
    owner: NativeCoordinatorValueOwner;
    window:
      | Readonly<{
          lastSequence: number;
          identities: readonly NativeCoordinatorControlDeclarationIdentity[];
        }>
      | undefined;
    session: CoordinatorValueWorkSession;
    runStore: CoordinatorRunStore;
    readTimeoutMillis: number;
    hydrate:
      ReturnType<typeof createCoordinatorControlSourceHydration> | undefined;
  }>,
): LoadCoordinatorControlDeclaration {
  const unavailable = () =>
    new CallableCompletionStoppedError({
      kind: 'unavailable',
      reason: 'source_read_failed',
    });
  const inventory = async () => {
    const load = input.runStore.loadCoordinatorControlSources;
    const window = input.window;
    if (load === undefined || window === undefined) throw unavailable();
    const response = await input.session.perform((signal) =>
      load.call(input.runStore, {
        owner: structuredClone(input.owner),
        lastSequence: window.lastSequence,
        expected: structuredClone(window.identities),
        signal,
        readTimeoutMillis: input.readTimeoutMillis,
      }),
    );
    if (response.kind === 'stopped')
      throw new CallableCompletionStoppedError(response.stop);
    return parseCoordinatorControlDeclarationInventory(
      response.sources,
      input.owner,
      window.identities,
    );
  };
  let sources: ReturnType<typeof inventory> | undefined;
  return async (identity, signal) => {
    if (signal !== input.session.signal)
      throw new TypeError('Control demand signal differs');
    sources ??= inventory();
    const selected = (await sources).filter(
      (source) =>
        source.sequence === identity.sequence &&
        source.attemptId === identity.attemptId &&
        source.invocationKey === identity.invocationKey,
    );
    const source = selected[0];
    if (selected.length !== 1 || source === undefined)
      throw new TypeError('Control demand physical fact differs');
    const hydrate = input.hydrate;
    if (hydrate === undefined) throw unavailable();
    const value = await input.session.perform((currentSignal) =>
      hydrate({
        owner: input.owner,
        source,
        signal: currentSignal,
      }),
    );
    const original = source.valueSource.valueIdentity;
    return {
      kind: 'ready',
      material: {
        ...identity,
        output: source.output,
        value,
        valueIdentity: {
          reference: original.reference,
          sha256: original.sha256,
          byteLength: original.byteLength,
        },
      },
    };
  };
}
