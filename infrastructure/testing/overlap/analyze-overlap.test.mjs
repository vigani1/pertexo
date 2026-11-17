import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  analyzeOverlap,
  areaOf,
  describeTestFile,
  weightedOverlap,
} from './analyze-overlap.mjs';
import { renderMarkdown } from './render-overlap.mjs';

const passed = (reached) => ({
  status: 'passed',
  tests: { passed: 1, failed: 0, skipped: 0 },
  seconds: 1,
  reached,
});

// `one` reaches lines `two` reaches, and `two` reaches lines the integration
// `flow` reaches; `three` alone reaches Y. `broken` failed, so the line it
// shares with `flow` must not count.
function reports({ broken = { status: 'failed' } } = {}) {
  return [
    {
      workspace: 'api',
      lane: 'unit',
      shard: null,
      files: {
        'apps/api/test/a/one.test.ts': passed({ 'apps/api/src/x.ts': [1, 2] }),
        'apps/api/test/a/two.test.ts': passed({
          'apps/api/src/x.ts': [1, 2, 3],
        }),
        'apps/api/test/b/three.test.ts': passed({ 'apps/api/src/y.ts': [1] }),
        'apps/api/test/b/broken.test.ts': {
          ...passed({ 'apps/api/src/x.ts': [4] }),
          ...broken,
        },
      },
    },
    {
      workspace: 'api',
      lane: 'integration',
      shard: { index: 1, total: 2 },
      files: {
        'apps/api/test/a/flow.integration.test.ts': passed({
          'apps/api/src/x.ts': [1, 2, 3, 4],
        }),
      },
    },
  ];
}

const sources = {
  'apps/api/test/a/one.test.ts': "it('a', () => {});\n",
  'apps/api/test/a/two.test.ts':
    "it('a', () => {});\nit('b', () => {});\nit('c', () => {});\n",
  'apps/api/test/b/three.test.ts': "it('a', () => {});\n",
  'apps/api/test/b/broken.test.ts': "it('a', () => {});\n",
  'apps/api/test/a/flow.integration.test.ts': "it('flow', () => {});\n",
};
const readSource = (file) => sources[file];
const files = (list) => list.map(({ file }) => file);

test('counts the lines each file reaches that no other measured file reaches', () => {
  const { tests } = analyzeOverlap(reports(), { readSource });
  assert.deepEqual(
    Object.fromEntries(tests.map((t) => [t.file, t.reachedByNoOther])),
    {
      'apps/api/test/a/flow.integration.test.ts': 1,
      'apps/api/test/a/one.test.ts': 0,
      'apps/api/test/a/two.test.ts': 0,
      'apps/api/test/b/three.test.ts': 1,
    },
  );
});

test('a failed file is left out of every comparison and listed as not measured', () => {
  const summary = analyzeOverlap(reports(), { readSource });
  assert.deepEqual(files(summary.notMeasured), [
    'apps/api/test/b/broken.test.ts',
  ]);
  assert.ok(!files(summary.tests).includes('apps/api/test/b/broken.test.ts'));
  // Had it counted, `flow` would share line 4 and reach nothing new.
  assert.ok(
    !files(summary.lists.noNewReach).includes(
      'apps/api/test/a/flow.integration.test.ts',
    ),
  );
  const counted = analyzeOverlap(reports({ broken: {} }), { readSource });
  assert.ok(
    files(counted.lists.noNewReach).includes(
      'apps/api/test/a/flow.integration.test.ts',
    ),
  );
});

test('lists files reaching nothing new, largest first', () => {
  const { lists } = analyzeOverlap(reports(), { readSource });
  assert.deepEqual(files(lists.noNewReach), [
    'apps/api/test/a/two.test.ts',
    'apps/api/test/a/one.test.ts',
  ]);
});

test('names an integration container before a closer unit one', () => {
  const { lists } = analyzeOverlap(reports(), { readSource });
  const one = lists.contained.find(
    ({ file }) => file === 'apps/api/test/a/one.test.ts',
  );
  assert.equal(one.container, 'apps/api/test/a/flow.integration.test.ts');
  assert.equal(one.containerIsIntegration, true);
  assert.equal(one.containers, 2);
  assert.deepEqual(files(lists.contained), [
    'apps/api/test/a/two.test.ts',
    'apps/api/test/a/one.test.ts',
  ]);
});

test('a file whose reach is only partly inside another is not contained', () => {
  const [unit, integration] = reports();
  // Its rarest line, y:5, is shared only with `other`, which reaches more
  // lines but not x:1 or x:2.
  unit.files['apps/api/test/a/one.test.ts'] = passed({
    'apps/api/src/x.ts': [1, 2],
    'apps/api/src/y.ts': [5],
  });
  unit.files['apps/api/test/b/other.test.ts'] = passed({
    'apps/api/src/y.ts': [5, 6, 7, 8],
  });
  const { lists } = analyzeOverlap([unit, integration], {
    readSource: (file) => sources[file] ?? '',
  });
  assert.ok(!files(lists.contained).includes('apps/api/test/a/one.test.ts'));
});

test('among unit containers, names the one with the smallest reach', () => {
  const [unit] = reports();
  unit.files['apps/api/test/a/wide.test.ts'] = passed({
    'apps/api/src/x.ts': [1, 2, 3, 7, 8],
  });
  const { lists, groups } = analyzeOverlap([unit], {
    readSource: (file) => sources[file] ?? '',
  });
  const one = lists.contained.find(
    ({ file }) => file === 'apps/api/test/a/one.test.ts',
  );
  assert.equal(one.container, 'apps/api/test/a/two.test.ts');
  assert.equal(one.containerIsIntegration, false);
  const unitGroup = groups.find(({ lane }) => lane === 'unit');
  assert.equal(unitGroup.containedByIntegration, 0);
  assert.equal(unitGroup.containedByIntegrationLines, 0);
});

test('a file reaching no line reaches nothing new and is inside no other', () => {
  const [unit, integration] = reports();
  unit.files['apps/api/test/b/empty.test.ts'] = passed({});
  const { lists } = analyzeOverlap([unit, integration], {
    readSource: (file) => sources[file] ?? '',
  });
  assert.ok(files(lists.noNewReach).includes('apps/api/test/b/empty.test.ts'));
  assert.ok(!files(lists.contained).includes('apps/api/test/b/empty.test.ts'));
});

test('summarizes each workspace and lane', () => {
  const { groups } = analyzeOverlap(reports(), { readSource });
  const unit = groups.find(({ lane }) => lane === 'unit');
  assert.equal(unit.files, 4);
  assert.equal(unit.measured, 3);
  assert.equal(unit.noNewReach, 2);
  assert.equal(unit.noNewReachShare, 2 / 3);
  assert.equal(unit.noNewReachLines, 4);
  assert.equal(unit.containedByIntegration, 2);
  assert.equal(unit.containedByIntegrationLines, 4);
});

test('the same test file in two reports is refused', () => {
  const [unit] = reports();
  assert.throws(
    () => analyzeOverlap([unit, unit], { readSource }),
    /in two reports/,
  );
});

test('lines every file reaches weigh nothing in the overlap', () => {
  const a = { ids: [0, 1], idSet: new Set([0, 1]) };
  const b = { ids: [0, 2], idSet: new Set([0, 2]) };
  assert.equal(weightedOverlap(a, b, [0, 1, 1]), 0);
  assert.equal(
    weightedOverlap(
      { ids: [0, 1], idSet: new Set([0, 1]) },
      { ids: [0, 1], idSet: new Set([0, 1]) },
      [0, 1],
    ),
    1,
  );
  assert.equal(
    weightedOverlap(
      { ids: [1, 2], idSet: new Set([1, 2]) },
      { ids: [1, 3], idSet: new Set([1, 3]) },
      [0, 1, 1, 2],
    ),
    1 / 4,
  );
});

test('clusters same-area files whose reach overlaps, never across areas', () => {
  const shared = { 'apps/api/src/z.ts': [1, 2, 3] };
  const unit = {
    workspace: 'api',
    lane: 'unit',
    shard: null,
    files: {
      'apps/api/test/a/p.test.ts': passed(shared),
      'apps/api/test/a/q.test.ts': passed({
        'apps/api/src/z.ts': [1, 2, 3, 4],
      }),
      'apps/api/test/b/r.test.ts': passed(shared),
      'apps/api/test/a/s.test.ts': passed({ 'apps/api/src/w.ts': [1] }),
      'apps/api/test/c/t.test.ts': passed({ 'apps/api/src/v.ts': [1] }),
    },
  };
  const options = { readSource: () => "it('x', () => {});\n" };
  // z:1-3 weigh ln(5/3) each, z:4 ln(5): p and q overlap 0.49; p and r, in
  // another area, overlap fully.
  const { lists } = analyzeOverlap([unit], { ...options, threshold: 0.45 });
  assert.deepEqual(
    lists.clusters.map((cluster) => [cluster.area, files(cluster.members)]),
    [
      [
        'api unit a',
        ['apps/api/test/a/p.test.ts', 'apps/api/test/a/q.test.ts'],
      ],
    ],
  );
  assert.equal(lists.clusters[0].sharedLines, 3);
  assert.equal(lists.clusters[0].unionLines, 4);
  const strict = analyzeOverlap([unit], { ...options, threshold: 0.5 });
  assert.deepEqual(strict.lists.clusters, []);
});

test('an area is the workspace, the lane and the first directory under test', () => {
  assert.equal(
    areaOf({
      file: 'apps/web/test/features/runs/list.test.tsx',
      workspace: 'web',
      lane: 'unit',
    }),
    'web unit features',
  );
  assert.equal(
    areaOf({
      file: 'apps/web/test/foundation.test.tsx',
      workspace: 'web',
      lane: 'unit',
    }),
    'web unit (top)',
  );
});

test('describes a test file: lines, tests, mocks and keep marks', () => {
  const shape = describeTestFile(
    'apps/api/test/a/sign.test.ts',
    [
      "vi.mock('./x');",
      'const send = vi.fn();',
      "vi.spyOn(console, 'log');",
      'vi.mocked(send);',
      "describe('webhooks', () => {",
      "  it('rejects a forged signature', () => {});",
      "  it.each([1, 2])('pads %i', () => {});",
      "  test.skipIf(true)('skipped', () => {});",
      '  expect(/a/.test("a")).toBe(true);',
      '});',
      '',
    ].join('\n'),
  );
  assert.deepEqual(shape, {
    testLines: 10,
    its: 3,
    mocks: 3,
    keep: ['security'],
  });
});

test('renders the headline table and every list', () => {
  const markdown = renderMarkdown(analyzeOverlap(reports(), { readSource }));
  assert.match(
    markdown,
    /\| api \| unit \| 4 \| 6 \| 3 \| 2 \(66\.7%\) \| 4 \|/,
  );
  assert.match(markdown, /one\.test\.ts.*⊆ `apps\/api\/test\/a\/flow/);
  assert.match(markdown, /## Not measured \(1\)/);
});
