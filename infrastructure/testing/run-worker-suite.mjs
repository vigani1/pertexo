import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  printServiceLogs,
  pullServices,
  report,
  runLogged,
  startStack,
  stopStacks,
  summary,
} from './side-by-side.mjs';

/**
 * The worker suite's files share Redis databases by number, so they run one at a time
 * per stack. Each shard gets a whole stack, on one runner.
 */
export function shardCommand(shard, stacks, extraArguments = []) {
  return {
    args: [
      '--filter',
      '@pertexo/worker',
      'exec',
      'vitest',
      'run',
      '--config',
      'vitest.integration.config.ts',
      `--shard=${String(shard + 1)}/${String(stacks)}`,
      ...extraArguments,
    ],
    env: {},
  };
}

export function workerSuitePhases(stacks, extraArguments = []) {
  const shards = Array.from({ length: stacks }, (_, stack) => ({
    label: `worker-${String(stack + 1)}`,
    stack,
    command: shardCommand(stack, stacks, extraArguments),
  }));
  if (extraArguments.length > 0) return [shards];
  // Cold process recovery competes with all three shards for the runner's CPU.
  // Keep its proof and timeout, but give it the runner before starting the shards.
  const recoveryFile =
    'test/runs/consumer/foreach-cancellation.integration.test.ts';
  const recovery = shardCommand(0, 1);
  recovery.args = recovery.args.filter((arg) => !arg.startsWith('--shard='));
  recovery.args.push(recoveryFile);
  for (const { command } of shards)
    command.args.push(`--exclude=${recoveryFile}`);
  return [
    [{ label: 'worker-foreach-recovery', stack: 0, command: recovery }],
    shards,
  ];
}

const migrate = { args: ['db:migrate'], env: {} };

async function main([stackCount, ...extraArguments]) {
  const stacks = Number(stackCount);
  if (!Number.isInteger(stacks) || stacks < 1)
    throw new Error(
      'usage: run-worker-suite.mjs <side-by-side stacks> [vitest arguments]',
    );
  const directory = mkdtempSync(join(tmpdir(), 'pertexo-worker-suite-'));
  const slots = Array.from({ length: stacks }, (_, slot) => slot);
  await pullServices();
  const environments = await Promise.all(slots.map(startStack));
  try {
    // One at a time: migrating takes seconds, and a pnpm that decides to reinstall
    // must not race another.
    for (const shard of slots) {
      const migration = await runLogged(
        `migrate-${String(shard + 1)}`,
        migrate,
        environments[shard],
        directory,
      );
      if (migration.passed) continue;
      report(migration);
      process.exitCode = 1;
      return;
    }
    const results = [];
    for (const phase of workerSuitePhases(stacks, extraArguments)) {
      results.push(
        ...(await Promise.all(
          phase.map(async ({ label, stack, command }) => {
            const result = await runLogged(
              label,
              command,
              environments[stack],
              directory,
            );
            report(result);
            if (!result.passed) await printServiceLogs(environments[stack]);
            return result;
          }),
        )),
      );
    }
    console.log(summary(results));
    if (results.some(({ passed }) => !passed)) process.exitCode = 1;
  } finally {
    await stopStacks(environments);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main(process.argv.slice(2));
}
