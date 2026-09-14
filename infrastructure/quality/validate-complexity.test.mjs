import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  findComplexityRegressions,
  inventoryComplexity,
} from './validate-complexity.mjs';

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

test('keeps same-line, same-method names uniquely addressable by lexical owner', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'pertexo-complexity-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const sourceDirectory = path.join(root, 'packages/example/src');
  await Promise.all([
    mkdir(sourceDirectory, { recursive: true }),
    mkdir(path.join(root, 'apps'), { recursive: true }),
  ]);
  const guards = (count) =>
    Array.from(
      { length: count },
      (_, index) => `if(v===${String(index)})v++;`,
    ).join('');
  await writeFile(
    path.join(sourceDirectory, 'same-line.ts'),
    `class Alpha { run(v:number){${guards(41)}return v;} run(v:number){${guards(43)}return v;} } class Beta { run(v:number){${guards(42)}return v;} }\n`,
  );

  const inventory = await inventoryComplexity(root);
  assert.deepEqual(Object.keys(inventory.functionHotspots).sort(), [
    'packages/example/src/same-line.ts#Alpha.run',
    'packages/example/src/same-line.ts#Alpha.run@2',
    'packages/example/src/same-line.ts#Beta.run',
  ]);
  assert.equal(
    inventory.functionHotspots['packages/example/src/same-line.ts#Alpha.run']
      .branches,
    41,
  );
  assert.equal(
    inventory.functionHotspots['packages/example/src/same-line.ts#Beta.run']
      .branches,
    42,
  );

  const changed = JSON.parse(JSON.stringify(inventory));
  changed.functionHotspots[
    'packages/example/src/same-line.ts#Beta.run'
  ].branches += 1;
  assert.deepEqual(findComplexityRegressions(changed, inventory), [
    'function hotspot worsened: packages/example/src/same-line.ts#Beta.run 1/42 -> 1/43',
  ]);
});
