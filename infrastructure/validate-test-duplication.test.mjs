import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { validateCloneReport } from './validate-test-duplication.mjs';

const fragment = 'const repeated = true;';
const hash = createHash('sha256').update(fragment).digest('hex');
const scope = {
  families: [
    {
      classification: 'intentional-scenario-local',
      clones: [{ hash, maxLines: 20 }],
      files: ['a.test.ts', 'b.test.ts'],
      reason:
        'The two public scenarios deliberately show their distinct actions and assertions.',
    },
  ],
  maximums: { clones: 1, duplicatedLines: 20, duplicatedTokens: 100 },
};

function report(overrides = {}) {
  return {
    duplicates: [
      {
        firstFile: { name: 'a.test.ts' },
        fragment,
        lines: 20,
        secondFile: { name: 'b.test.ts' },
      },
    ],
    statistics: {
      total: {
        clones: 1,
        duplicatedLines: 20,
        duplicatedTokens: 100,
        percentage: 0.1,
      },
    },
    ...overrides,
  };
}

test('accepts an exact reviewed clone baseline', () => {
  assert.deepEqual(validateCloneReport('test', scope, report()), []);
});

test('rejects an unexplained clone even when aggregate totals stay flat', () => {
  const changed = report();
  changed.duplicates[0].fragment = 'const semanticChange = true;';
  assert.match(
    validateCloneReport('test', scope, changed).join('\n'),
    /unexplained clone/u,
  );
});

test('rejects aggregate or individual clone growth', () => {
  const changed = report();
  changed.statistics.total.duplicatedLines = 21;
  changed.duplicates[0].lines = 21;
  assert.match(
    validateCloneReport('test', scope, changed).join('\n'),
    /duplicatedLines worsened/u,
  );
  assert.match(
    validateCloneReport('test', scope, changed).join('\n'),
    /clone family 1 review 1 grew/u,
  );
});

test('rejects stale, harmful, or unexplained baseline entries', () => {
  const harmful = JSON.parse(JSON.stringify(scope));
  harmful.families[0].classification = 'harmful-duplication';
  assert.match(
    validateCloneReport('test', harmful, report()).join('\n'),
    /unsupported classification/u,
  );
  assert.match(
    validateCloneReport('test', scope, {
      ...report(),
      duplicates: [],
      statistics: {
        total: {
          clones: 0,
          duplicatedLines: 0,
          duplicatedTokens: 0,
          percentage: 0,
        },
      },
    }).join('\n'),
    /is stale/u,
  );
});

test('rejects one stale review inside a multi-clone family', () => {
  const multiple = JSON.parse(JSON.stringify(scope));
  multiple.families[0].clones.push({
    hash: createHash('sha256').update('another fragment').digest('hex'),
    maxLines: 10,
  });
  assert.match(
    validateCloneReport('test', multiple, report()).join('\n'),
    /review 2 is stale/u,
  );
});

test('enforces each reviewed clone line ceiling independently', () => {
  const multiple = JSON.parse(JSON.stringify(scope));
  multiple.maximums.duplicatedLines = 100;
  multiple.families[0].clones[0].maxLines = 19;
  assert.match(
    validateCloneReport('test', multiple, report()).join('\n'),
    /review 1 grew from 19 to 20 lines/u,
  );
});

test('rejects missing and malformed report totals before comparison', () => {
  for (const changed of [
    {},
    { statistics: { total: {} }, duplicates: [] },
    report({
      statistics: {
        total: {
          clones: Number.NaN,
          duplicatedLines: -1,
          duplicatedTokens: 1.5,
          percentage: Number.POSITIVE_INFINITY,
        },
      },
    }),
    report({
      statistics: {
        total: {
          clones: '1',
          duplicatedLines: null,
          duplicatedTokens: 100,
          percentage: 0,
        },
      },
    }),
  ])
    assert.notEqual(validateCloneReport('test', scope, changed).length, 0);
});

test('rejects malformed, duplicate, and count-mismatched clone evidence', () => {
  const malformed = report();
  malformed.duplicates[0].lines = -1;
  assert.match(
    validateCloneReport('test', scope, malformed).join('\n'),
    /duplicate 1 is malformed/u,
  );

  const duplicated = report();
  duplicated.duplicates.push(
    JSON.parse(JSON.stringify(duplicated.duplicates[0])),
  );
  duplicated.statistics.total.clones = 2;
  assert.match(
    validateCloneReport('test', scope, duplicated).join('\n'),
    /duplicate clone evidence/u,
  );

  const mismatched = report();
  mismatched.statistics.total.clones = 0;
  assert.match(
    validateCloneReport('test', scope, mismatched).join('\n'),
    /clone total does not match evidence/u,
  );
});
