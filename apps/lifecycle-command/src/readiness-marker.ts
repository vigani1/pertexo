import { rm, writeFile } from 'node:fs/promises';

const defaultReadinessMarker = '/tmp/pertexo-lifecycle-command-ready';

export interface LifecycleCommandReadinessMarker {
  clear(): Promise<void>;
  mark(): Promise<void>;
}

export function createLifecycleCommandReadinessMarker(
  markerPath = defaultReadinessMarker,
): LifecycleCommandReadinessMarker {
  return Object.freeze({
    clear: () => rm(markerPath, { force: true }),
    mark: () => writeFile(markerPath, '', { mode: 0o600 }),
  });
}
