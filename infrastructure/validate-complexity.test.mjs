import assert from 'node:assert/strict';
import test from 'node:test';

import { findComplexityRegressions } from './validate-complexity.mjs';

const baseline = Object.freeze({
  fileHotspots: { 'packages/example/src/existing.ts': 550 },
  functionHotspots: {
    'packages/example/src/existing.ts#orchestrate': {
      branches: 45,
      lines: 220,
    },
  },
});

test('accepts unchanged or reduced existing hotspots', () => {
  assert.deepEqual(
    findComplexityRegressions(
      {
        fileHotspots: { 'packages/example/src/existing.ts': 540 },
        functionHotspots: {
          'packages/example/src/existing.ts#orchestrate': {
            branches: 44,
            lines: 210,
          },
        },
      },
      baseline,
    ),
    [],
  );
});

test('rejects new and worsened hotspots', () => {
  const errors = findComplexityRegressions(
    {
      fileHotspots: {
        'packages/example/src/existing.ts': 551,
        'packages/example/src/new.ts': 501,
      },
      functionHotspots: {
        'packages/example/src/existing.ts#orchestrate': {
          branches: 46,
          lines: 220,
        },
        'packages/example/src/new.ts#execute': { branches: 41, lines: 201 },
      },
    },
    baseline,
  );
  assert.equal(errors.length, 4);
  assert.match(errors.join('\n'), /new file hotspot/u);
  assert.match(errors.join('\n'), /file hotspot worsened/u);
  assert.match(errors.join('\n'), /new function hotspot/u);
  assert.match(errors.join('\n'), /function hotspot worsened/u);
});
