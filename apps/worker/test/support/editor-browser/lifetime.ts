import { WorkerDrainState } from '../../../src/runtime/shutdown/drain-state.js';
import {
  closeEditorBrowserWorkerRuntimes,
  EditorBrowserWorkerShutdownError,
  type EditorBrowserWorkerRuntimes,
} from './cleanup.js';

export type EditorBrowserRuntimeConstruction = {
  -readonly [
    Key in keyof EditorBrowserWorkerRuntimes
  ]: EditorBrowserWorkerRuntimes[Key];
} & { drain: WorkerDrainState };

/** Owns this fixture's setup/restart/stop, including partially built resources. */
export function createEditorBrowserWorkerLifetime(
  namespace: Readonly<{ close(): Promise<void> }>,
  construct: (
    resources: EditorBrowserRuntimeConstruction,
    assertActive: () => void,
  ) => Promise<void>,
) {
  let stopped = false;
  let started = false;
  let restartUsed = false;
  let busy = false;
  let poisoned: 'startup' | 'restart' | undefined;
  let resources: EditorBrowserRuntimeConstruction = {
    drain: new WorkerDrainState(),
  };
  let activity: Promise<void> = Promise.resolve();
  let closing: Promise<void> | undefined;
  const assertActive = () => {
    if (stopped || poisoned !== undefined)
      throw new Error('Owned worker construction is no longer active');
  };
  const build = async () => {
    assertActive();
    await construct(resources, assertActive);
    assertActive();
  };
  const operate = (
    phase: 'startup' | 'restart',
    operation: () => Promise<void>,
  ) => {
    busy = true;
    activity = operation()
      .catch((error: unknown) => {
        poisoned = phase;
        throw error;
      })
      .finally(() => {
        busy = false;
      });
    return activity;
  };
  return {
    start() {
      assertActive();
      if (started) throw new Error('Owned worker was already started');
      started = true;
      return operate('startup', build);
    },
    restart() {
      assertActive();
      if (!started || busy || restartUsed)
        throw new Error('Owned worker restart is unavailable');
      restartUsed = true;
      return operate('restart', async () => {
        resources.drain.beginDrain();
        await closeEditorBrowserWorkerRuntimes(resources);
        assertActive();
        resources = { drain: new WorkerDrainState() };
        await build();
      });
    },
    close() {
      stopped = true; // Fence construction synchronously, before awaiting it.
      closing ??= (async () => {
        await activity.catch(() => undefined);
        resources.drain.beginDrain();
        const errors: unknown[] = [];
        try {
          await closeEditorBrowserWorkerRuntimes(resources);
        } catch (error) {
          errors.push(error);
        }
        if (poisoned !== undefined || errors.length > 0)
          throw new EditorBrowserWorkerShutdownError(
            [
              ...(poisoned === undefined ? [] : [poisoned]),
              ...errors.flatMap((error) =>
                error instanceof EditorBrowserWorkerShutdownError
                  ? error.phases
                  : (['restart'] as const),
              ),
            ],
            errors,
          );
        try {
          await namespace.close();
        } catch (error) {
          throw new EditorBrowserWorkerShutdownError(
            ['redis-namespace'],
            [error],
          );
        }
      })();
      return closing;
    },
  };
}
