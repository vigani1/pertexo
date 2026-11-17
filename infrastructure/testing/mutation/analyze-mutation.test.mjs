import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyzeReport,
  keepReasons,
  renderCombinedMarkdown,
  renderMarkdown,
} from './analyze-mutation.mjs';

const at = (line) => ({
  start: { line, column: 1 },
  end: { line, column: 5 },
});

function mutant(
  id,
  status,
  { killedBy, coveredBy = [], line = 1, ...rest } = {},
) {
  return {
    id,
    mutatorName: 'ConditionalExpression',
    replacement: 'true',
    status,
    location: at(line),
    coveredBy,
    ...(killedBy ? { killedBy } : {}),
    ...rest,
  };
}

// Four tests: `alpha` alone catches m1, `beta` and `gamma` both catch m2,
// `delta` runs against m3 and catches nothing.
function report({ files, tests } = {}) {
  return {
    schemaVersion: '1.0',
    files: files ?? {
      'src/rules.ts': {
        language: 'typescript',
        source: '',
        mutants: [
          mutant('m1', 'Killed', { killedBy: ['a'], coveredBy: ['a', 'b'] }),
          mutant('m2', 'Killed', {
            killedBy: ['b', 'c'],
            coveredBy: ['b', 'c'],
          }),
          mutant('m3', 'Survived', { coveredBy: ['d'], line: 7 }),
          mutant('m4', 'NoCoverage', { line: 3 }),
          mutant('m5', 'CompileError', { line: 9 }),
        ],
      },
    },
    testFiles: tests ?? {
      'test/rules.test.ts': {
        tests: [
          { id: 'a', name: 'alpha sorts names' },
          { id: 'b', name: 'beta trims input' },
          { id: 'c', name: 'gamma pads output' },
          { id: 'd', name: 'delta formats dates' },
        ],
      },
    },
  };
}

const names = (tests) => tests.map((test) => test.name);

test('counts caught mutants over the valid ones, with timeouts as caught', () => {
  const summary = analyzeReport(
    report({
      files: {
        'src/a.ts': {
          mutants: [
            mutant('m1', 'Killed', { killedBy: ['a'], coveredBy: ['a'] }),
            mutant('m2', 'Timeout', { coveredBy: ['a'] }),
            mutant('m3', 'Survived', { coveredBy: ['a'] }),
            mutant('m4', 'NoCoverage'),
            mutant('m5', 'RuntimeError'),
            mutant('m6', 'Ignored'),
          ],
        },
      },
    }),
    'demo',
  );
  assert.deepEqual(
    {
      mutants: summary.package.mutants,
      valid: summary.package.valid,
      caught: summary.package.caught,
      share: summary.package.caughtShare,
    },
    { mutants: 6, valid: 4, caught: 2, share: 0.5 },
  );
});

test('reports a workspace without valid mutants as having no share', () => {
  const summary = analyzeReport(
    report({ files: { 'src/a.ts': { mutants: [mutant('m1', 'Ignored')] } } }),
    'demo',
  );
  assert.equal(summary.package.caughtShare, null);
});

test('records per test what it covered, caught and caught alone', () => {
  const summary = analyzeReport(report(), 'demo');
  const byName = Object.fromEntries(
    summary.tests.map((test) => [
      test.name,
      [test.covered, test.caught, test.caughtByNoOther],
    ]),
  );
  assert.deepEqual(byName, {
    'alpha sorts names': [1, 1, 1],
    'beta trims input': [2, 1, 0],
    'gamma pads output': [1, 1, 0],
    'delta formats dates': [1, 0, 0],
  });
});

test('a static mutant counts as run by every test, not as reached by them', () => {
  // Stryker runs every test against a static mutant; only `alpha` catches it.
  const summary = analyzeReport(
    report({
      files: {
        'src/a.ts': {
          mutants: [
            mutant('m1', 'Killed', { killedBy: ['a'], static: true }),
            mutant('m2', 'Survived', { static: true }),
            mutant('m3', 'RuntimeError', { static: true }),
          ],
        },
      },
    }),
    'demo',
  );
  assert.deepEqual(
    summary.tests.map((test) => [
      test.name,
      test.covered,
      test.ranStatic,
      test.caught,
    ]),
    [
      ['alpha sorts names', 0, 2, 1],
      ['beta trims input', 0, 2, 0],
      ['delta formats dates', 0, 2, 0],
      ['gamma pads output', 0, 2, 0],
    ],
  );
  assert.deepEqual(names(summary.lists.catchNothing), []);
  assert.deepEqual(names(summary.lists.coverNoMutant), [
    'beta trims input',
    'delta formats dates',
    'gamma pads output',
  ]);
});

test('lists tests that cover mutated code but catch nothing', () => {
  const summary = analyzeReport(report(), 'demo');
  assert.deepEqual(names(summary.lists.catchNothing), ['delta formats dates']);
});

test('lists tests whose every catch another test also makes', () => {
  const summary = analyzeReport(report(), 'demo');
  assert.deepEqual(names(summary.lists.allCaughtElsewhere), [
    'beta trims input',
    'gamma pads output',
  ]);
});

test('sets apart tests that cover no mutated code instead of judging them', () => {
  const summary = analyzeReport(
    report({
      tests: {
        'test/rules.test.ts': {
          tests: [
            { id: 'a', name: 'alpha sorts names' },
            { id: 'b', name: 'beta trims input' },
            { id: 'c', name: 'gamma pads output' },
            { id: 'd', name: 'delta formats dates' },
            { id: 'e', name: 'epsilon reads another module' },
          ],
        },
      },
    }),
    'demo',
  );
  assert.deepEqual(names(summary.lists.coverNoMutant), [
    'epsilon reads another module',
  ]);
  assert.ok(
    !names(summary.lists.catchNothing).includes('epsilon reads another module'),
  );
});

test('the smallest set keeps every catch with the fewest tests', () => {
  // `wide` catches m1 to m3; `left` and `right` each catch two of them, and only
  // `right` catches m4. Greedy picks `wide`, then `right`.
  const summary = analyzeReport(
    report({
      files: {
        'src/a.ts': {
          mutants: [
            mutant('m1', 'Killed', { killedBy: ['wide', 'left'] }),
            mutant('m2', 'Killed', { killedBy: ['wide', 'left'] }),
            mutant('m3', 'Killed', { killedBy: ['wide', 'right'] }),
            mutant('m4', 'Killed', { killedBy: ['right'] }),
            mutant('m5', 'Survived', { coveredBy: ['left'] }),
          ],
        },
      },
      tests: {
        'test/a.test.ts': {
          tests: [
            { id: 'left', name: 'left' },
            { id: 'right', name: 'right' },
            { id: 'wide', name: 'wide' },
          ],
        },
      },
    }),
    'demo',
  );
  assert.deepEqual(names(summary.lists.minimalSet), ['wide', 'right']);
});

test('breaks ties in the smallest set by file and name, so runs agree', () => {
  const summary = analyzeReport(
    report({
      files: {
        'src/a.ts': {
          mutants: [mutant('m1', 'Killed', { killedBy: ['z', 'y'] })],
        },
      },
      tests: {
        'test/b.test.ts': { tests: [{ id: 'z', name: 'same' }] },
        'test/a.test.ts': { tests: [{ id: 'y', name: 'same' }] },
      },
    }),
    'demo',
  );
  assert.deepEqual(
    summary.lists.minimalSet.map((test) => test.file),
    ['test/a.test.ts'],
  );
});

test('groups survivors and uncovered mutants by file and line', () => {
  const summary = analyzeReport(
    report({
      files: {
        'src/b.ts': { mutants: [mutant('m1', 'Survived', { line: 4 })] },
        'src/a.ts': {
          mutants: [
            mutant('m2', 'NoCoverage', { line: 9 }),
            mutant('m3', 'Survived', { line: 2, mutatorName: 'StringLiteral' }),
            mutant('m4', 'Killed', { line: 2, killedBy: ['a'] }),
            mutant('m5', 'Survived', { line: 2 }),
          ],
        },
      },
    }),
    'demo',
  );
  assert.deepEqual(
    summary.package.survivors.map(({ file, lines }) => [
      file,
      lines.map(({ line, mutants }) => [
        line,
        mutants.map((item) => `${item.mutator}:${item.status}`),
      ]),
    ]),
    [
      [
        'src/a.ts',
        [
          [2, ['StringLiteral:Survived', 'ConditionalExpression:Survived']],
          [9, ['ConditionalExpression:NoCoverage']],
        ],
      ],
      ['src/b.ts', [[4, ['ConditionalExpression:Survived']]]],
    ],
  );
});

test('refuses a report that names a test it does not list', () => {
  assert.throws(
    () =>
      analyzeReport(
        report({
          files: {
            'src/a.ts': {
              mutants: [mutant('m1', 'Killed', { killedBy: ['ghost'] })],
            },
          },
        }),
        'demo',
      ),
    /unknown test ghost/u,
  );
});

test('marks tests about security, isolation, permissions and data loss for keeping', () => {
  assert.deepEqual(keepReasons('test/a.test.ts', 'rejects a forged webhook'), [
    'security',
  ]);
  assert.deepEqual(
    keepReasons('test/workspaces/isolation.test.ts', 'hides rows'),
    ['workspace isolation'],
  );
  assert.deepEqual(keepReasons('test/a.test.ts', 'denies editing to a guest'), [
    'permissions',
  ]);
  assert.deepEqual(
    keepReasons('test/a.test.ts', 'keeps the run after a purge retry'),
    ['data loss'],
  );
  assert.deepEqual(keepReasons('test/format.test.ts', 'pads output'), []);
});

test('a kept test still appears in the lists, marked with its reason', () => {
  const summary = analyzeReport(
    report({
      tests: {
        'test/rules.test.ts': {
          tests: [
            { id: 'a', name: 'alpha sorts names' },
            { id: 'b', name: 'beta trims input' },
            { id: 'c', name: 'gamma pads output' },
            { id: 'd', name: 'delta redacts secrets' },
          ],
        },
      },
    }),
    'demo',
  );
  assert.deepEqual(
    summary.lists.catchNothing.map((test) => [test.name, test.keep]),
    [['delta redacts secrets', ['security']]],
  );
  assert.match(
    renderMarkdown(summary),
    /delta redacts secrets \(covers 1, catches 0, alone 0\) — keep: security/u,
  );
});

test('the Markdown summary shows totals, lists and survivors', () => {
  const markdown = renderMarkdown(analyzeReport(report(), 'demo'));
  assert.match(markdown, /^# Mutation summary: demo$/mu);
  assert.match(markdown, /^- Mutants: 5 \(4 valid\)$/mu);
  assert.match(markdown, /^- Caught: 2 \(50\.0%\)$/mu);
  assert.match(markdown, /^### Cover mutated code but catch nothing \(1\)$/mu);
  assert.match(
    markdown,
    /^### Every catch also caught by another test \(2\)$/mu,
  );
  assert.match(
    markdown,
    /^- line 3: ConditionalExpression \(no test runs it\)$/mu,
  );
  assert.match(markdown, /^- line 7: ConditionalExpression$/mu);
});

test('escapes Markdown in test names', () => {
  const summary = analyzeReport(
    report({
      tests: {
        'test/rules.test.ts': {
          tests: [
            { id: 'a', name: 'alpha' },
            { id: 'b', name: 'beta' },
            { id: 'c', name: 'gamma' },
            { id: 'd', name: 'reads `a|b` *now*' },
          ],
        },
      },
    }),
    'demo',
  );
  assert.match(renderMarkdown(summary), /reads \\`a\\\|b\\` \\\*now\\\*/u);
});

test('the combined summary has one row per workspace, in name order', () => {
  const zeta = analyzeReport(report(), 'zeta');
  const alpha = analyzeReport(report(), 'alpha');
  const rows = renderCombinedMarkdown([zeta, alpha])
    .split('\n')
    .filter((line) => /^\| (alpha|zeta) /u.test(line));
  assert.deepEqual(rows, [
    '| alpha | 5 | 50.0% | 4 | 1 | 2 | 2 |',
    '| zeta | 5 | 50.0% | 4 | 1 | 2 | 2 |',
  ]);
});
