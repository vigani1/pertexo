import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  BROWSER_COVERAGE_VARIABLE,
  builtChunks,
  readBrowserCoverage,
  readTestCounts,
} from './run-spec-coverage.mjs';

function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), 'overlap-specs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Playwright's JSON report for tests of `file` with these statuses. */
function report(file, statuses, errors = []) {
  return {
    suites: [
      {
        title: file,
        suites: [
          {
            title: 'group',
            specs: statuses.map((status, index) => ({
              file,
              title: `test ${String(index)}`,
              tests: [{ status }],
            })),
          },
        ],
      },
    ],
    errors,
  };
}

function writeReport(t, value) {
  const path = join(temporary(t), 'results.json');
  writeFileSync(path, JSON.stringify(value));
  return path;
}

test('counts passed, flaky, skipped and failed tests of the spec', (t) => {
  const path = writeReport(
    t,
    report('workspace/deletion.spec.ts', [
      'expected',
      'flaky',
      'skipped',
      'unexpected',
    ]),
  );
  assert.deepEqual(readTestCounts(path, 'e2e/workspace/deletion.spec.ts'), {
    passed: 2,
    failed: 1,
    skipped: 1,
  });
});

test('a run that never reached its tests counts as failed', (t) => {
  const path = writeReport(
    t,
    report('workspace/deletion.spec.ts', [], [{ message: 'no server' }]),
  );
  assert.equal(
    readTestCounts(path, 'e2e/workspace/deletion.spec.ts').failed,
    1,
  );
});

test('refuses a run that also ran another spec', (t) => {
  const path = writeReport(t, report('workspace/audit.spec.ts', ['expected']));
  assert.throws(
    () => readTestCounts(path, 'e2e/workspace/deletion.spec.ts'),
    /also ran: workspace\/audit\.spec\.ts/u,
  );
});

/** A dist folder with a manifest; `mapped` chunks get a map beside them. */
function writeDist(root, { mapped, unmapped = [] }) {
  const dist = join(root, 'dist');
  mkdirSync(join(dist, '.vite'), { recursive: true });
  mkdirSync(join(dist, 'assets'), { recursive: true });
  const manifest = {};
  for (const file of [...mapped, ...unmapped]) {
    manifest[`_${file}`] = { file };
    writeFileSync(join(dist, file), '');
  }
  for (const file of mapped) writeFileSync(join(dist, `${file}.map`), '{}');
  writeFileSync(join(dist, '.vite/manifest.json'), JSON.stringify(manifest));
  return dist;
}

test('measures the chunks built from source, not the bundler runtime', (t) => {
  const dist = writeDist(temporary(t), {
    mapped: ['assets/index-a.js', 'assets/page-b.js'],
    unmapped: ['assets/rolldown-runtime-c.js'],
  });
  assert.deepEqual([...builtChunks(dist)].sort(), [
    'assets/index-a.js',
    'assets/page-b.js',
  ]);
});

test('refuses a build without source maps', (t) => {
  const dist = writeDist(temporary(t), {
    mapped: [],
    unmapped: ['assets/index-a.js'],
  });
  assert.throws(() => builtChunks(dist), /no source maps/u);
});

test("reads the scripts each test ran from this run's built chunks", (t) => {
  const root = temporary(t);
  const coverage = join(root, 'coverage');
  mkdirSync(coverage);
  const functions = [{ ranges: [{ startOffset: 0, endOffset: 1, count: 1 }] }];
  writeFileSync(
    join(coverage, 'first.json'),
    JSON.stringify({
      result: [
        { url: 'http://127.0.0.1:4174/assets/index-a.js', functions },
        // The appearance script is a plain asset with no map.
        { url: 'http://127.0.0.1:4174/assets/appearance-1.js', functions },
        // Another run's server.
        { url: 'http://127.0.0.1:4173/assets/index-a.js', functions },
      ],
    }),
  );
  writeFileSync(
    join(coverage, 'second.json'),
    JSON.stringify({
      result: [{ url: 'http://127.0.0.1:4174/assets/page-b.js', functions }],
    }),
  );
  const scripts = readBrowserCoverage(
    coverage,
    4174,
    new Set(['assets/index-a.js', 'assets/page-b.js']),
    '/dist',
  );
  assert.deepEqual(scripts.map(({ file }) => file).sort(), [
    '/dist/assets/index-a.js',
    '/dist/assets/page-b.js',
  ]);
  assert.deepEqual(scripts[0].functions, functions);
});

test('a spec that recorded nothing reads as no scripts', (t) => {
  assert.deepEqual(
    readBrowserCoverage(join(temporary(t), 'none'), 4173, new Set()),
    [],
  );
});

test('the e2e config reads the variable the runner sets', () => {
  const config = readFileSync(
    new URL('../../../apps/web/playwright.config.ts', import.meta.url),
    'utf8',
  );
  assert.match(
    config,
    new RegExp(`process\\.env\\.${BROWSER_COVERAGE_VARIABLE}\\b`, 'u'),
  );
});
