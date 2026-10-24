import type { ChildProcess } from 'node:child_process';

import { execFile } from 'node:child_process';

import { promisify } from 'node:util';

import { FixtureResourceOwner } from '../../harness/resource-owner.js';

import { ownEditorBrowserProcess } from '../../harness/process.js';
import { verifyEditorBrowserOwnership } from '../../harness/ownership.js';

import { fixtureState } from './state.js';

export const owner = new FixtureResourceOwner();

export const browserChildren: ChildProcess[] = [];

export const openBrowserInstances = new Set<string>();

const processOwners = new WeakMap<
  ChildProcess,
  ReturnType<typeof ownEditorBrowserProcess>
>();

export function ownChild<T extends ChildProcess>(
  name: string,
  child: T,
  kind: 'browser' | 'vite' | 'worker',
): T {
  processOwners.set(
    child,
    ownEditorBrowserProcess(child, kind, {
      browserDisposed: () =>
        fixtureState.browserWasOpened && openBrowserInstances.size === 0,
    }),
  );
  return owner.acquire(name, child, closeChild);
}

export function assertHttpDependenciesDisposable(
  child: ChildProcess | undefined,
) {
  if (child === undefined) return;
  if (processOwners.get(child)?.diagnostics().stage !== 'disposed')
    throw new Error('Worker drain unconfirmed; retain HTTP dependencies');
}

export const restartScope = new AbortController();

export function assertRestartScopeActive() {
  if (restartScope.signal.aborted) throw new Error('Schedule fixture disposed');
}

export function phase(child: ChildProcess, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.off('message', message);
      child.off('error', failed);
      child.off('exit', exited);
      if (error === undefined) resolve();
      else reject(error);
    };
    const message = (value: unknown) => {
      if (
        typeof value === 'object' &&
        value !== null &&
        'phase' in value &&
        value.phase === expected
      )
        finish();
    };
    const failed = (error: Error) => {
      finish(error);
    };
    const exited = () => {
      finish(new Error(`Owned worker exited before ${expected}`));
    };
    const timer = setTimeout(() => {
      finish(new Error(`Owned worker did not reach ${expected}`));
    }, 15_000);
    child.on('message', message);
    child.once('error', failed);
    child.once('exit', exited);
  });
}

export async function recheckOwnership(): Promise<void> {
  await verifyEditorBrowserOwnership(process.env, async (id) => {
    const { stdout } = await promisify(execFile)('docker', ['inspect', id], {
      timeout: 4_000,
      maxBuffer: 1_048_576,
    });
    return stdout;
  });
}

export async function closeChild(child: ChildProcess): Promise<void> {
  const processOwner = processOwners.get(child);
  if (processOwner === undefined)
    throw new Error('Refusing disposal of an unowned process');
  try {
    await processOwner.close();
  } catch (error) {
    // Only fixed fields and allowed system codes, never raw/nested runtime errors.
    const code =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string' &&
      ['ESRCH', 'EPERM', 'EINVAL'].includes(error.code)
        ? error.code
        : undefined;
    process.stderr.write(
      `Owned process cleanup diagnostic ${JSON.stringify({
        ...processOwner.diagnostics(),
        code,
      })}\n`,
    );
    throw error;
  }
}
