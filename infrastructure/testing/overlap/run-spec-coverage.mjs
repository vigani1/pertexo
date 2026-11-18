import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { mockedFilePatterns, mockedSpecFiles } from '../mocked-shards.mjs';
import { addScriptCoverage } from './child-coverage.mjs';
import {
  fileStatus,
  measureEach,
  parseShard,
  pickShard,
  writeLaneReport,
} from './lane-run.mjs';
import { createReach } from './source-lines.mjs';

// Runs each spec of the web app's mocked Playwright suite alone, in Chromium,
// with JavaScript coverage, and writes reports/overlap/web-e2e[-<i>of<n>].json
// in the shape the Vitest runner writes. The app is built once, with source
// maps and without minification, so each bundled statement maps back to its
// own `src` line; every spec then runs against that build.

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const webDirectory = join(repositoryRoot, 'apps/web');
const distDirectory = join(webDirectory, 'dist');

/** The variable playwright.config.ts passes on as the coverage fixture's directory. */
export const BROWSER_COVERAGE_VARIABLE = 'PERTEXO_OVERLAP_BROWSER_COVERAGE';

// The Chromium projects: every mocked spec is in exactly one of them.
const PROJECTS = ['chromium', 'chromium-still-flaky'];

// The e2e config's own port, and the next ones for specs running beside it.
const FIRST_PORT = 4173;

// A spec that hangs must not hold a shard until the job's own limit.
const SPEC_TIMEOUT_MILLISECONDS = 15 * 60_000;

async function main() {
  const { values } = parseArgs({
    options: {
      shard: { type: 'string' },
      concurrency: { type: 'string', default: '1' },
      // Narrows a run to named specs (`e2e/<path>`), for trying it on a slice.
      only: { type: 'string', multiple: true },
    },
  });
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error(
      'usage: run-spec-coverage.mjs [--shard i/n] [--concurrency n] [--only e2e/<spec>]...',
    );
  const shard = values.shard === undefined ? null : parseShard(values.shard);
  const all = mockedSpecFiles(join(webDirectory, 'e2e')).sort();
  const narrowed = values.only
    ? all.filter((file) => values.only.includes(file))
    : all;
  if (values.only && narrowed.length !== values.only.length)
    throw new Error(
      `Not a mocked spec: ${values.only.filter((file) => !all.includes(file)).join(', ')}`,
    );
  const specs = shard ? pickShard(narrowed, shard) : narrowed;
  if ((await run('pnpm', BUILD_ARGUMENTS, {})) !== 0)
    throw new Error('The web build failed');
  const chunks = builtChunks(distDirectory);
  const scratch = mkdtempSync(join(tmpdir(), 'pertexo-overlap-e2e-'));
  let measured;
  try {
    measured = await measureEach(specs, concurrency, (spec, slot) =>
      measureSpec(spec, FIRST_PORT + slot, chunks, scratch),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const records = Object.fromEntries(
    Object.entries(measured.records).map(([spec, record]) => [
      relative(repositoryRoot, join(webDirectory, spec)),
      record,
    ]),
  );
  writeLaneReport(repositoryRoot, {
    workspace: 'web',
    lane: 'e2e',
    shard,
    records,
  });
  if (measured.failed.length > 0) {
    console.error(`Failed specs:\n${measured.failed.join('\n')}`);
    process.exitCode = 1;
  }
}

// Source maps lead each statement back to `src`; minification would fold
// statements into one, which the Vitest lane's count never does. The
// manifest names the chunks the build made.
const BUILD_ARGUMENTS = [
  'exec',
  'vite',
  'build',
  '--sourcemap',
  '--minify',
  'false',
  '--manifest',
];

/**
 * The JavaScript chunks Vite built from source, by their path below `dist`.
 * Rolldown's runtime chunk holds only bundler helpers and gets no map; a
 * build without any map is a mistake, since no line could be found.
 */
export function builtChunks(directory) {
  const manifest = JSON.parse(
    readFileSync(join(directory, '.vite/manifest.json'), 'utf8'),
  );
  const chunks = new Set(
    Object.values(manifest)
      .map(({ file }) => file)
      .filter(
        (file) =>
          file.endsWith('.js') && existsSync(join(directory, `${file}.map`)),
      ),
  );
  if (chunks.size === 0)
    throw new Error(`${directory} has no source maps; build with --sourcemap`);
  return chunks;
}

async function measureSpec(spec, port, chunks, scratch) {
  const own = mkdtempSync(join(scratch, 'spec-'));
  const results = join(own, 'results.json');
  const coverage = join(own, 'coverage');
  const started = Date.now();
  const exitCode = await run(
    'pnpm',
    [
      'exec',
      'playwright',
      'test',
      ...PROJECTS.map((project) => `--project=${project}`),
      '--workers=1',
      '--reporter=list,json',
      // Each run cleans its output folder; runs side by side need their own.
      `--output=${join(own, 'output')}`,
      ...mockedFilePatterns([spec]),
    ],
    {
      PERTEXO_MOCK_WEB_PORT: String(port),
      [BROWSER_COVERAGE_VARIABLE]: coverage,
      PLAYWRIGHT_JSON_OUTPUT_FILE: results,
    },
  );
  const seconds = Math.round((Date.now() - started) / 1000);
  const tests = readTestCounts(results, spec);
  const reach = createReach(repositoryRoot);
  const scripts = readBrowserCoverage(coverage, port, chunks);
  if (tests.passed > 0 && scripts.length === 0)
    throw new Error(
      `${spec} passed but recorded no coverage; does it import test from e2e/support/fixtures.ts?`,
    );
  addScriptCoverage(reach, scripts, repositoryRoot);
  rmSync(own, { recursive: true, force: true });
  return {
    status: fileStatus(exitCode, tests),
    tests,
    seconds,
    reached: reach.lines(),
  };
}

/**
 * The coverage the fixture wrote for each test, as built files: a script the
 * preview server served from a chunk built from source. Other scripts (the
 * appearance script, emitted as a plain asset, and anything a test serves
 * itself) are left out.
 */
export function readBrowserCoverage(
  directory,
  port,
  chunks,
  dist = distDirectory,
) {
  if (!existsSync(directory)) return [];
  const origin = `http://127.0.0.1:${String(port)}`;
  const scripts = [];
  for (const name of readdirSync(directory)) {
    const { result } = JSON.parse(readFileSync(join(directory, name), 'utf8'));
    for (const { url, functions } of result) {
      if (!url.startsWith(`${origin}/`)) continue;
      const path = new URL(url).pathname.slice(1);
      if (chunks.has(path)) scripts.push({ file: join(dist, path), functions });
    }
  }
  return scripts;
}

/** Counts the spec's tests from Playwright's JSON report. */
export function readTestCounts(results, spec) {
  const counts = { passed: 0, failed: 0, skipped: 0 };
  if (!existsSync(results)) return counts;
  const report = JSON.parse(readFileSync(results, 'utf8'));
  const specsRan = new Set();
  const visit = (suite) => {
    for (const child of suite.suites ?? []) visit(child);
    for (const { file, tests } of suite.specs ?? []) {
      specsRan.add(file);
      for (const { status } of tests)
        if (status === 'expected' || status === 'flaky') counts.passed++;
        else if (status === 'skipped') counts.skipped++;
        else counts.failed++;
    }
  };
  for (const suite of report.suites) visit(suite);
  const expected = spec.replace(/^e2e\//u, '');
  const others = [...specsRan].filter((file) => file !== expected);
  if (others.length > 0)
    throw new Error(`Running ${spec} alone also ran: ${others.join(', ')}`);
  // A run that never reached its tests (a broken config, a server that never
  // started) reports its errors here.
  if (report.errors?.length > 0) counts.failed += report.errors.length;
  return counts;
}

function run(command, args, environment) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: webDirectory,
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'inherit', 'inherit'],
      timeout: SPEC_TIMEOUT_MILLISECONDS,
      killSignal: 'SIGKILL',
    });
    child.once('error', () => resolve(1));
    child.once('close', (code) => resolve(code ?? 1));
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
