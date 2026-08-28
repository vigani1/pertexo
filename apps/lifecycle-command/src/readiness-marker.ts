import { rm, writeFile } from 'node:fs/promises';

const readinessMarker = '/tmp/pertexo-lifecycle-command-ready';

export interface LifecycleCommandReadinessMarker {
  clear(): Promise<void>;
  mark(): Promise<void>;
}

export function createLifecycleCommandReadinessMarker(): LifecycleCommandReadinessMarker {
  return Object.freeze({
    clear: () => rm(readinessMarker, { force: true }),
    mark: () => writeFile(readinessMarker, '', { mode: 0o600 }),
  });
}
