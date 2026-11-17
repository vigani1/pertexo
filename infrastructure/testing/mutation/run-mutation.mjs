import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Stryker } from '@stryker-mutator/core';

// Runs Stryker for one Vitest workspace and writes reports/mutation/<workspace>.json.
// It works in place (imports reaching outside the package break in Stryker's
// copied sandbox): Stryker rewrites the workspace's source, tests and Vitest
// config while it runs and restores them afterwards. So it refuses a workspace
// with uncommitted changes, and Git can always put back what an interrupted run
// leaves behind. Run it only in a disposable checkout or on CI.

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

// Entry files only re-export or start a process, type-only files have no
// runtime code, and generated files are rewritten rather than edited.
const NOT_MUTATED = [
  '**/index.ts',
  '**/server.ts',
  '**/public.ts',
  '**/testing.ts',
  '**/main.ts',
  '**/main.tsx',
  '**/startup.ts',
  '**/*.types.ts',
  '**/*.d.ts',
  '**/*.gen.ts',
  '**/*.generated.ts',
];
const MUTATED = 'src/**/*.{ts,tsx}';
const TEMPORARY_VITEST_CONFIG = 'vitest.mutation.config.ts';
// Stryker counts coverage inside every statement, so instrumented code runs
// several times slower than in the normal suite.
const INSTRUMENTED_TEST_TIMEOUT_MILLISECONDS = 60_000;
// Test files that fail on unmutated code under Stryker, so its first run would
// stop the whole workspace. They are left out of the measurement, which means
// pruning never judges them: they stay as they are.
const NOT_MEASURED = {
  // A checkpoint at the authoring limits has a 60 s budget that instrumented
  // code exceeds.
  'workflow-engine': ['test/checkpoint/capacity.test.ts'],
  // Redacting a 10 MiB response: one file asserts wall-clock time, and in the
  // other the client's own request deadline runs out on instrumented code.
  secrets: [
    'test/outbound-http/response-redaction-performance.test.ts',
    'test/outbound-http/stream-redaction-rules.test.ts',
  ],
  // Reads emitter source text, which Stryker rewrites in place.
  observability: ['test/operations-assets.test.ts'],
};

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    concurrency: { type: 'string', default: String(availableParallelism()) },
    // Narrows the run to a slice, e.g. --mutate 'src/flow/**/*.ts'.
    mutate: { type: 'string', multiple: true },
  },
});
const [workspace] = positionals;
const concurrency = Number(values.concurrency);
if (
  positionals.length !== 1 ||
  !Number.isInteger(concurrency) ||
  concurrency < 1
)
  throw new Error(
    'usage: run-mutation.mjs <workspace> [--concurrency <n>] [--mutate <glob>]...',
  );

const workspaceDirectory = findWorkspace(workspace);
requireCleanWorkspace(workspaceDirectory);
const reportFile = join(
  repositoryRoot,
  'reports/mutation',
  `${workspace}.json`,
);
mkdirSync(join(repositoryRoot, 'reports/mutation'), { recursive: true });

// Some tests start worker threads from the compiled package, so the workspace
// itself is built as well as its dependencies.
run('pnpm', [
  '--filter',
  `@pertexo/${workspace}...`,
  'run',
  '--if-present',
  'build',
]);

const vitestConfig = join(workspaceDirectory, TEMPORARY_VITEST_CONFIG);
writeFileSync(vitestConfig, unitLaneConfig(NOT_MEASURED[workspace] ?? []));
try {
  process.chdir(workspaceDirectory);
  const stryker = new Stryker({
    testRunner: 'vitest',
    // pnpm's strict layout hides the runner from Stryker's own plugin lookup.
    plugins: [
      fileURLToPath(import.meta.resolve('@stryker-mutator/vitest-runner')),
    ],
    vitest: { configFile: TEMPORARY_VITEST_CONFIG, related: false },
    inPlace: true,
    // Without this Stryker stops at the first test that catches a mutant, and
    // `killedBy` cannot show which tests are redundant.
    disableBail: true,
    // A static (module-level) mutant reruns the whole suite and records no
    // per-test coverage, so it cannot show which test protects what. On the
    // first full run these took most of the time and pushed contracts and
    // workflow-model past their budget.
    ignoreStatic: true,
    coverageAnalysis: 'perTest',
    concurrency,
    mutate: [
      ...(values.mutate ?? [MUTATED]),
      ...NOT_MUTATED.map((pattern) => `!${pattern}`),
    ],
    reporters: ['json', 'progress-append-only'],
    jsonReporter: { fileName: reportFile },
    allowEmpty: true,
  });
  await stryker.runMutationTest();
} finally {
  rmSync(vitestConfig, { force: true });
}
console.log(`Wrote ${reportFile}`);

// The unit lane: the workspace's own Vitest config without the integration
// lane, which needs live services.
function unitLaneConfig(notMeasured) {
  const exclude = [
    'dist/**',
    '.stryker-tmp/**',
    '**/*.integration.test.ts',
    ...notMeasured,
  ];
  return `import { configDefaults, mergeConfig } from 'vitest/config';
import base from './vitest.config.ts';

export default mergeConfig(base, {
  test: {
    testTimeout: ${INSTRUMENTED_TEST_TIMEOUT_MILLISECONDS},
    exclude: [...configDefaults.exclude, ${exclude.map((p) => JSON.stringify(p)).join(', ')}],
  },
});
`;
}

function findWorkspace(name) {
  if (!/^[a-z0-9-]+$/u.test(name ?? ''))
    throw new Error(`Invalid workspace name: ${name}`);
  for (const area of ['packages', 'apps']) {
    const directory = join(repositoryRoot, area, name);
    if (existsSync(join(directory, 'vitest.config.ts'))) return directory;
  }
  throw new Error(`No Vitest workspace named ${name} in packages/ or apps/`);
}

function requireCleanWorkspace(directory) {
  const status = run(
    'git',
    ['status', '--porcelain', '--untracked-files=all', '--', directory],
    {
      capture: true,
    },
  );
  if (status.trim())
    throw new Error(
      `Refusing to mutate ${directory} in place with uncommitted changes:\n${status}`,
    );
}

function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} exited with ${result.status}`,
    );
  return result.stdout ?? '';
}
