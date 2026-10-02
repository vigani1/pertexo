import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspect } from 'node:util';

import {
  OwnedProcessSupervisor,
  runManagedCommand,
} from '../support/owned-process-tree.mjs';

export const CI_QUALITY_SCRIPTS = Object.freeze([
  'docs:check',
  'format:check',
  'runtime:check',
  'network-registry:check',
  'dependencies:check',
  'database:schema:check',
  'lint',
  'complexity:check',
  'duplication:check',
  'contracts:check',
  'typecheck',
]);

export function parseCiQualityArguments(args) {
  const expected = [
    '--quality',
    ...CI_QUALITY_SCRIPTS,
    '--contracts',
    'quality:local:check',
  ];
  if (JSON.stringify(args) !== JSON.stringify(expected))
    throw new Error(
      'CI quality must name every original gate exactly once in its fixed lane',
    );
  return [CI_QUALITY_SCRIPTS, ['quality:local:check']];
}

// Build must finish before this entrypoint. Contract CLI fixtures own their
// source/build workspaces; only the quality lane may emit shared build outputs.
export async function runCiQuality(args, options = {}) {
  const lanes = parseCiQualityArguments(args);
  const supervisor = options.supervisor ?? new OwnedProcessSupervisor();
  const signal = options.signal;
  const cwd = options.cwd ?? fileURLToPath(new URL('../..', import.meta.url));
  const env = options.env ?? process.env;
  let termination;
  const cancel = () => {
    termination ??= supervisor.terminateAll();
    // Observe rejection immediately; the final join still reports this failure.
    termination.catch(() => undefined);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  const runLane = async (scripts) => {
    for (const script of scripts) {
      signal?.throwIfAborted();
      process.stdout.write(`[ci-quality] start ${script}\n`);
      await runManagedCommand({
        command: 'pnpm',
        args: [script],
        // Inherit the log pipeline directly: the OS applies backpressure without
        // accumulating both lanes in the owner's JavaScript writable buffers.
        spawnOptions: { cwd, env, stdio: ['ignore', 'inherit', 'inherit'] },
        spawnOwned: supervisor.spawn.bind(supervisor),
        releaseOwned: supervisor.release.bind(supervisor),
        failure: (code, childSignal) =>
          new Error(
            `CI quality gate ${script} failed (${String(code ?? childSignal)})`,
          ),
      });
      signal?.throwIfAborted();
      process.stdout.write(`[ci-quality] passed ${script}\n`);
    }
  };
  const results = await Promise.allSettled(lanes.map(runLane));
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  try {
    await termination;
  } catch (error) {
    failures.push(error);
  }
  try {
    await supervisor.terminateAll();
  } catch (error) {
    failures.push(error);
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
  if (failures.length > 0)
    throw new AggregateError(failures, 'CI quality lanes failed');
}

async function main() {
  const supervisor = new OwnedProcessSupervisor();
  const controller = new AbortController();
  let receivedSignal;
  let failure;
  const interrupt = (signal) => {
    receivedSignal ??= signal;
    controller.abort(new Error(`CI quality interrupted by ${signal}`));
  };
  const sigint = () => interrupt('SIGINT');
  const sigterm = () => interrupt('SIGTERM');
  const exit = () => supervisor.killAllSync();
  process.on('SIGINT', sigint);
  process.on('SIGTERM', sigterm);
  process.on('exit', exit);
  try {
    await runCiQuality(process.argv.slice(2), {
      supervisor,
      signal: controller.signal,
    });
  } catch (error) {
    failure = error;
    process.exitCode =
      receivedSignal === 'SIGINT'
        ? 130
        : receivedSignal === 'SIGTERM'
          ? 143
          : 1;
  } finally {
    process.off('SIGINT', sigint);
    process.off('SIGTERM', sigterm);
    try {
      // Async cleanup failures retain ownership. Release the final owned trees
      // synchronously before removing the emergency hook and allowing CLI exit.
      supervisor.killAllSync();
      process.off('exit', exit);
    } catch (error) {
      failure = new AggregateError(
        failure === undefined ? [error] : [failure, error],
        'CI quality failed with emergency cleanup failure',
      );
      process.exitCode = 1;
      // Keep the exit hook for one final owned retry; never hide fallback errors.
    }
  }
  if (failure !== undefined) console.error(inspect(failure, { depth: null }));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await main();
