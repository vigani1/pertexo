import assert from 'node:assert/strict';
import test from 'node:test';
import { validateFolderLayout } from './validate-folder-layout.mjs';

const crowded = 'packages/example/src/area';
const deep = 'packages/example/src/one/two/three/four/five';
const peers = Array.from(
  { length: 16 },
  (_, index) => `${crowded}/peer-${index}.ts`,
);

test('refuses a planted crowded folder', () => {
  assert.match(
    validateFolderLayout(peers, {}, {}).join(),
    /16 direct code files/u,
  );
});
test('refuses a planted deep folder', () => {
  assert.match(
    validateFolderLayout([`${deep}/file.ts`], {}, {}).join(),
    /more than four/u,
  );
});
test('accepts listed folders and an ancestor exception', () => {
  assert.deepEqual(
    validateFolderLayout(
      [...peers, `${deep}/child/file.ts`],
      { [crowded]: 'Peer catalog.' },
      { [deep]: 'Named subject.' },
    ),
    [],
  );
});
test('refuses exceptions that no longer need listing', () => {
  assert.equal(
    validateFolderLayout(
      [],
      { [crowded]: 'Peer catalog.' },
      { [deep]: 'Named subject.' },
    ).length,
    2,
  );
});
test('accepts four directory levels without an exception', () => {
  assert.deepEqual(
    validateFolderLayout(
      ['packages/example/src/one/two/three/four/file.ts'],
      {},
      {},
    ),
    [],
  );
});
