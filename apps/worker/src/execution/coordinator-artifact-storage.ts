import {
  createDualRegionArtifactStore,
  type ArtifactStore,
  type DualRegionArtifactStoreConfig,
} from '@pertexo/artifact-store';
import type { CoordinatorRunStore } from '@pertexo/database/execution';

export type CoordinatorArtifactStorage = Readonly<{
  store?: Pick<ArtifactStore, 'getStream'>;
  checkReadiness(): Promise<void>;
  close(): void;
}>;

/** One framework resource, gated by the actual release-admitted native read owner. */
export function createCoordinatorArtifactStorage(
  runStore: Pick<
    CoordinatorRunStore,
    'readCoordinatorCallDeclaration' | 'readCallableCompletionSource'
  >,
  config: DualRegionArtifactStoreConfig | undefined,
  borrowed: Pick<ArtifactStore, 'getStream' | 'checkReadiness'> | undefined,
  factory: typeof createDualRegionArtifactStore = createDualRegionArtifactStore,
): CoordinatorArtifactStorage {
  const native =
    runStore.readCoordinatorCallDeclaration !== undefined ||
    runStore.readCallableCompletionSource !== undefined;
  const owned =
    !native || borrowed !== undefined || config === undefined
      ? undefined
      : factory(config.primary, config.recovery);
  const store = native ? (borrowed ?? owned) : undefined;
  let closed = false;
  return Object.freeze({
    ...(store === undefined ? {} : { store }),
    checkReadiness: async () => {
      if (closed) throw new Error('Coordinator artifact storage is closed');
      await store?.checkReadiness();
    },
    close: () => {
      if (closed) return;
      closed = true;
      owned?.close();
    },
  });
}
