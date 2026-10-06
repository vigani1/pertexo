import type { ArtifactStore } from '@pertexo/artifact-store';
import type { CoordinatorRunStore } from '@pertexo/database/execution';
import type { CoordinatorNativeValueWork } from './coordinator-native-demand-advance.js';
import { createCoordinatorSourceHydration } from './coordinator-source-hydration.js';
import { createCoordinatorResultSourceHydration } from './coordinator-result-source-hydration.js';
import { createCoordinatorControlSourceHydration } from './coordinator-control-source-hydration.js';
import { createCoordinatorCallDeclarationHydration } from './coordinator-call-declaration-hydration.js';

/** Cohesive read-only composition over borrowed existing ports/storage/lifetimes. */
export function createCoordinatorSourceComposition(
  runStore: CoordinatorRunStore,
  valueWork: CoordinatorNativeValueWork,
  store?: Pick<ArtifactStore, 'getStream'>,
) {
  const hydrateSource =
    valueWork.hydrateSource ??
    createCoordinatorSourceHydration(
      runStore,
      valueWork.policy.controlReadTimeoutMillis,
      store,
    );
  return {
    hydrateSource,
    hydrateCallDeclaration: createCoordinatorCallDeclarationHydration(
      runStore,
      store,
      valueWork.policy.controlReadTimeoutMillis,
    ),
    hydrateResultSources: createCoordinatorResultSourceHydration(runStore, {
      ...valueWork,
      hydrateSource,
    }),
    hydrateControlSource: createCoordinatorControlSourceHydration(
      runStore,
      valueWork.policy.controlReadTimeoutMillis,
      store,
    ),
  };
}
