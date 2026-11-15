import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SECRET_OWNER,
  findSecretReads,
  inspectConnectionSecrets,
} from './validate-connection-secrets.mjs';

const file = 'packages/integrations/src/copied/step.executor.ts';

test('refuses a step reading a connection secret itself', () => {
  assert.deepEqual(
    findSecretReads(
      file,
      [
        'const text = new TextDecoder().decode(resolved.secret);',
        "resolved['secret'].fill(0);",
        'const { secret } = resolved;',
        'const { secret: key } = resolved;',
      ].join('\n'),
    ),
    [`${file}:1`, `${file}:2`, `${file}:3`, `${file}:4`],
  );
});

test('leaves the owner, declarations and other names alone', () => {
  assert.deepEqual(
    findSecretReads(SECRET_OWNER, 'resolved.secret.fill(0);'),
    [],
  );
  assert.deepEqual(
    findSecretReads(
      file,
      'type A = { secret: Uint8Array }; const b = { secret: c }; d.clientSecret;',
    ),
    [],
  );
});

test('finds no secret read in the real step packages', async () => {
  assert.deepEqual(await inspectConnectionSecrets(), []);
});
