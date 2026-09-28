import type { ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

/** Private groups contain ordinary children, not arbitrary detached descendants.
 * Browser cleanup requires its fixture's explicit close receipt.
 * A missing receipt fails closed; polling is never proof of all descendants. */
export function ownEditorBrowserProcess(
  child: ChildProcess,
  kind: 'browser' | 'vite' | 'worker',
  options: Readonly<{
    graceMs?: number;
    killMs?: number;
    browserDisposed?: () => boolean;
  }> = {},
) {
  let shutdownConfirmed = false;
  let shutdownFailures: string[] = [];
  let stage = 'not-started';
  child.on('message', (value: unknown) => {
    if (
      typeof value === 'object' &&
      value !== null &&
      'phase' in value &&
      value.phase === 'worker-shutdown'
    ) {
      shutdownConfirmed = 'success' in value && value.success === true;
      if ('failures' in value && Array.isArray(value.failures))
        shutdownFailures = value.failures.filter(
          (phase): phase is string =>
            typeof phase === 'string' &&
            [
              'startup',
              'shutdown',
              'dispatcher',
              'producer',
              'dispatcher-database',
              'attempts',
              'coordinator',
              'redis-namespace',
            ].includes(phase),
        );
    }
  });
  let closing: Promise<void> | undefined;
  return {
    diagnostics() {
      return {
        stage,
        acknowledged: shutdownConfirmed,
        exitCode: child.exitCode,
        signal: child.signalCode,
        phases: shutdownFailures,
      };
    },
    close(): Promise<void> {
      closing ??= (async () => {
        const pid = child.pid;
        const signalGroup = (signal: NodeJS.Signals | 0): boolean => {
          if (pid === undefined) return false;
          try {
            process.kill(-pid, signal);
            return true;
          } catch (error) {
            if (
              typeof error === 'object' &&
              error !== null &&
              'code' in error
            ) {
              if (error.code === 'ESRCH') return false;
              // Permission failure is not evidence that the group disappeared.
              // Poll it within the existing deadline; mutation signals still fail.
              if (signal === 0 && error.code === 'EPERM') return true;
            }
            throw error;
          }
        };
        stage = 'signal-term';
        signalGroup('SIGTERM');
        const started = Date.now();
        const grace = options.graceMs ?? 10_000;
        const deadline = grace + (options.killMs ?? 5_000);
        let forced = false;
        stage = 'wait-group';
        while (
          signalGroup(0) ||
          (pid !== undefined &&
            child.exitCode === null &&
            child.signalCode === null)
        ) {
          if (!forced && Date.now() - started >= grace) {
            stage = 'signal-kill';
            signalGroup('SIGKILL');
            forced = true;
            stage = 'wait-group';
          }
          if (Date.now() - started >= deadline) {
            stage = 'group-deadline';
            throw new Error(
              'Owned process group exit unconfirmed; preserve fixture',
            );
          }
          await delay(50);
        }
        if (kind === 'worker' && (!shutdownConfirmed || child.exitCode !== 0)) {
          stage = 'worker-proof';
          throw new Error(
            `Worker shutdown was not successful; preserve database and lease; ${JSON.stringify(
              {
                acknowledged: shutdownConfirmed,
                exitCode: child.exitCode,
                signal: child.signalCode,
                phases: shutdownFailures,
              },
            )}`,
          );
        }
        if (kind === 'browser' && options.browserDisposed?.() !== true) {
          stage = 'browser-proof';
          throw new Error('Browser shutdown is unconfirmed; preserve fixture');
        }
        if (forced) {
          stage = 'forced-exit';
          throw new Error(
            'Owned process required forced termination after confirmed group reaping',
          );
        }
        stage = 'disposed';
      })();
      return closing;
    },
  };
}
