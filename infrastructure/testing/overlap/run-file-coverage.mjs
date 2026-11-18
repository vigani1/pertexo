import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { addChildCoverage } from './child-coverage.mjs';
import { CHILD_COVERAGE_VARIABLE } from './child-coverage-preload.mjs';
import { createReach } from './source-lines.mjs';

// Runs each test file of one Vitest lane alone, with V8 coverage, and writes
// reports/overlap/<workspace>-<lane>[-<i>of<n>].json: for every test file, the
// source lines it executed. One Vitest process per file keeps each set exact;
// nothing carries over from another file.

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

const LANES = Object.freeze({
  unit: 'vitest.config.ts',
  integration: 'vitest.integration.config.ts',
});

// Mirrors what CI leaves out of each lane, so the measurement covers the same
// files CI runs there. The unit lane never takes integration files (core's
// unit config would), and the worker's recovery tests stop real services and
// belong to the fault jobs.
const NOT_IN_LANE = Object.freeze({
  unit: [/\.integration\.test\.tsx?$/u],
  integration: [],
});
const NOT_IN_WORKSPACE_LANE = Object.freeze({
  // Browser journeys drive these; CI's services job leaves them out too.
  'api:integration': [/^test\/browser\//u],
  'worker:unit': [/^test\/recovery\//u],
  'worker:integration': [/^test\/recovery\//u],
});

// What a workspace's own `test` script sets around Vitest.
const WORKSPACE_ENVIRONMENT = Object.freeze({
  web: { TZ: 'Europe/Belgrade' },
});

// V8's precise coverage, which Vitest turns on for the whole process, makes
// compute-heavy code about five times slower: five in-process TypeScript
// builds take 464 ms without it and 2,282 ms with call counts alone (this Mac,
// Node 24). So a test that fits its lane's limit in CI (worker-build.test.ts:
// 1.6 s of 5 s) can miss it here (5.1 s, alone). The run gives every lane
// limit this much more time; a test's own explicit limit is left as it is.
const COVERAGE_TIME_FACTOR = 5;

// A file that hangs must not hold a shard until the job's own limit.
const FILE_TIMEOUT_MILLISECONDS = 15 * 60_000;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      lane: { type: 'string' },
      shard: { type: 'string' },
      concurrency: { type: 'string', default: '1' },
      // Narrows a run to named test files, for trying the runner on a slice.
      only: { type: 'string', multiple: true },
    },
  });
  const [workspace] = positionals;
  const concurrency = Number(values.concurrency);
  const shard = values.shard === undefined ? null : parseShard(values.shard);
  if (
    positionals.length !== 1 ||
    !Object.hasOwn(LANES, values.lane ?? '') ||
    !Number.isInteger(concurrency) ||
    concurrency < 1
  )
    throw new Error(
      'usage: run-file-coverage.mjs <workspace> --lane unit|integration [--shard i/n] [--concurrency n] [--only <test file>]...',
    );
  const lane = values.lane;
  const directory = findWorkspace(workspace);
  const config = join(directory, LANES[lane]);
  const { files: all, limits } = await readLane(
    workspace,
    lane,
    directory,
    config,
  );
  const narrowed = values.only
    ? all.filter((file) => values.only.includes(file))
    : all;
  if (values.only && narrowed.length !== values.only.length)
    throw new Error(
      `Not in the ${lane} lane: ${values.only.filter((file) => !all.includes(file)).join(', ')}`,
    );
  const files = shard ? pickShard(narrowed, shard) : narrowed;
  const scratch = mkdtempSync(join(tmpdir(), 'pertexo-overlap-'));
  const records = {};
  const measure = async (file, label) => {
    const record = await measureFile(
      {
        directory,
        config,
        limits,
        environment: WORKSPACE_ENVIRONMENT[workspace],
      },
      file,
      scratch,
    );
    records[workspaceRelative(directory, file)] = record;
    console.log(
      `${label} ${file}: ${record.status}, ${String(countLines(record.reached))} lines, ${String(record.seconds)} s`,
    );
    return record;
  };
  const failed = [];
  try {
    await eachLimited(files, concurrency, async (file, index) => {
      const record = await measure(
        file,
        `[${String(index + 1)}/${String(files.length)}]`,
      );
      if (record.status === 'failed') failed.push(file);
    });
    // Coverage makes some tests several times slower (a SAML signing test
    // went from 1.4 s to 7.8 s), and with other files sharing the CPU a few
    // then pass their own explicit time limits, which no configuration can
    // raise. A file that failed beside others runs once more alone; one that
    // fails alone too stays failed.
    if (concurrency > 1)
      for (const file of failed.splice(0))
        if ((await measure(file, '[alone]')).status === 'failed')
          failed.push(file);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const output = join(
    repositoryRoot,
    'reports/overlap',
    `${workspace}-${lane}${shard ? `-${String(shard.index)}of${String(shard.total)}` : ''}.json`,
  );
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(
    output,
    `${JSON.stringify({ workspace, lane, shard, files: sortKeys(records) })}\n`,
  );
  console.log(`Wrote ${relative(repositoryRoot, output)}`);
  if (failed.length > 0) {
    console.error(`Failed test files:\n${failed.join('\n')}`);
    process.exitCode = 1;
  }
}

export function parseShard(text) {
  const match = /^(\d+)\/(\d+)$/u.exec(text);
  const index = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (!match || index < 1 || index > total)
    throw new Error(`--shard takes i/n with 1 <= i <= n, not ${text}`);
  return { index, total };
}

/** Round-robin over the sorted list, so neighbouring files (often of similar
 * weight) spread across shards. Every file lands in exactly one shard. */
export function pickShard(files, { index, total }) {
  return [...files]
    .sort()
    .filter((_, position) => position % total === index - 1);
}

function findWorkspace(name) {
  for (const area of ['apps', 'packages']) {
    const directory = join(repositoryRoot, area, name);
    if (existsSync(join(directory, 'package.json'))) return directory;
  }
  throw new Error(`No workspace named ${name}`);
}

/** The lane's test files, and its time limits scaled for coverage. */
async function readLane(workspace, lane, directory, config) {
  // Globbing only: no global setup runs, so listing needs no test stack.
  const { createVitest } = await import('vitest/node');
  const lister = await createVitest(
    'test',
    { root: directory, config, watch: false },
    {},
    {},
  );
  try {
    const specifications = await lister.globTestSpecifications();
    const excluded = [
      ...NOT_IN_LANE[lane],
      ...(NOT_IN_WORKSPACE_LANE[`${workspace}:${lane}`] ?? []),
    ];
    const files = [
      ...new Set(
        specifications.map(({ moduleId }) => relative(directory, moduleId)),
      ),
    ]
      .filter((file) => !excluded.some((pattern) => pattern.test(file)))
      .sort();
    const { testTimeout, hookTimeout } = lister.config;
    return {
      files,
      limits: {
        testTimeout: testTimeout * COVERAGE_TIME_FACTOR,
        hookTimeout: hookTimeout * COVERAGE_TIME_FACTOR,
      },
    };
  } finally {
    await lister.close();
  }
}

async function measureFile(
  { directory, config, limits, environment },
  file,
  scratch,
) {
  const own = mkdtempSync(join(scratch, 'file-'));
  const results = join(own, 'results.json');
  const children = join(own, 'children');
  const started = Date.now();
  const exitCode = await runVitest(
    directory,
    coveredEnvironment(environment, children),
    [
      'exec',
      'vitest',
      'run',
      '--config',
      config,
      // A filter matches by substring, so `a.test.ts` alone would also pick
      // `a.test.tsx`; the reporter's list of files below proves only one ran.
      join(directory, file),
      `--testTimeout=${String(limits.testTimeout)}`,
      `--hookTimeout=${String(limits.hookTimeout)}`,
      '--reporter=default',
      '--reporter=json',
      `--outputFile.json=${results}`,
      '--coverage.enabled',
      '--coverage.provider=v8',
      '--coverage.reporter=json',
      '--coverage.reportOnFailure',
      '--coverage.allowExternal',
      '--coverage.clean',
      `--coverage.reportsDirectory=${join(own, 'coverage')}`,
    ],
  );
  const seconds = Math.round((Date.now() - started) / 1000);
  const tests = readTestCounts(results, join(directory, file));
  const coverageFile = join(own, 'coverage/coverage-final.json');
  const reach = createReach(repositoryRoot);
  if (existsSync(coverageFile))
    addIstanbul(reach, JSON.parse(readFileSync(coverageFile, 'utf8')));
  addChildCoverage(reach, children, repositoryRoot);
  rmSync(own, { recursive: true, force: true });
  return {
    status: fileStatus(exitCode, tests),
    tests,
    seconds,
    reached: reach.lines(),
  };
}

/** Lets the processes a test starts write their V8 coverage to `children`. */
function coveredEnvironment(environment, children) {
  const preload = new URL('./child-coverage-preload.mjs', import.meta.url).href;
  return {
    ...environment,
    [CHILD_COVERAGE_VARIABLE]: children,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${preload}`]
      .filter(Boolean)
      .join(' '),
  };
}

function runVitest(directory, environment, args) {
  return new Promise((resolve) => {
    const child = spawn('pnpm', args, {
      cwd: directory,
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'inherit', 'inherit'],
      timeout: FILE_TIMEOUT_MILLISECONDS,
      killSignal: 'SIGKILL',
    });
    child.once('error', () => resolve(1));
    child.once('close', (code) => resolve(code ?? 1));
  });
}

function readTestCounts(results, expectedFile) {
  const counts = { passed: 0, failed: 0, skipped: 0 };
  if (!existsSync(results)) return counts;
  const { testResults } = JSON.parse(readFileSync(results, 'utf8'));
  const ran = testResults.map(({ name }) => name);
  if (ran.length > 1 || (ran.length === 1 && ran[0] !== expectedFile))
    throw new Error(
      `Running ${expectedFile} alone also ran: ${ran.join(', ')}`,
    );
  for (const { assertionResults } of testResults)
    for (const { status } of assertionResults)
      if (status === 'passed') counts.passed++;
      else if (status === 'failed') counts.failed++;
      else counts.skipped++;
  return counts;
}

export function fileStatus(exitCode, tests) {
  if (exitCode !== 0 || tests.failed > 0) return 'failed';
  return tests.passed > 0 ? 'passed' : 'skipped';
}

/**
 * Turns Vitest's Istanbul JSON into `source file -> executed lines`. Only
 * statements inside a function count: a module's top level runs whenever any
 * test imports it, so it says nothing about what the test exercises. Built
 * files (packages load each other from `dist`) map back to `src` through
 * their source maps.
 */
export function reachedSourceLines(coverage, root = repositoryRoot) {
  const reach = createReach(root);
  addIstanbul(reach, coverage);
  return reach.lines();
}

function addIstanbul(reach, coverage) {
  for (const [absolute, entry] of Object.entries(coverage))
    reach.add(absolute, executedStatementsInFunctions(entry));
}

function executedStatementsInFunctions({ statementMap, s, fnMap }) {
  const functions = Object.values(fnMap).map(({ loc }) => loc);
  return Object.entries(statementMap)
    .filter(([id]) => s[id] > 0)
    .map(([, { start }]) => start)
    .filter((start) =>
      functions.some((loc) => within(start, loc.start, loc.end)),
    );
}

function within(position, start, end) {
  const after =
    position.line > start.line ||
    (position.line === start.line && position.column >= start.column);
  const before =
    position.line < end.line ||
    (position.line === end.line && position.column <= end.column);
  return after && before;
}

function workspaceRelative(directory, file) {
  return relative(repositoryRoot, join(directory, file));
}

function countLines(reached) {
  return Object.values(reached).reduce((sum, lines) => sum + lines.length, 0);
}

function sortKeys(object) {
  return Object.fromEntries(
    Object.entries(object).sort(([a], [b]) => a.localeCompare(b, 'en')),
  );
}

async function eachLimited(items, limit, work) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        await work(items[index], index);
      }
    }),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
