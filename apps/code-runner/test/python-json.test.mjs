import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_CODE_SETTINGS } from '@pertexo/node-sdk';
import { createTaskProcessPool } from '../dist/process/pool.js';

let pool;
before(async () => {
  pool = await createTaskProcessPool({
    settings: DEFAULT_CODE_SETTINGS,
    mode: 'process',
    socketPath: '/tmp/unused-python-json.sock',
  });
});
after(async () => {
  await pool?.close();
});

async function execute(language, code) {
  const deadline = Date.now() + 5000;
  let slot;
  while ((slot = pool.reserve()) === undefined) {
    if (Date.now() > deadline) throw new Error('No task reservation available');
    await delay(20);
  }
  try {
    return await slot.run(
      { language, code, input: null, variables: {}, timeoutSeconds: 2 },
      new AbortController().signal,
    );
  } finally {
    await slot.release();
  }
}

for (const [name, python, javascript, output] of [
  [
    'dictionary',
    'a = {"n": 1}\nreturn [a, a]',
    'const a = {n:1}; return [a,a];',
    [{ n: 1 }, { n: 1 }],
  ],
  [
    'list',
    'a = [1, 2]\nreturn {"first": a, "second": a}',
    'const a = [1,2]; return {first:a,second:a};',
    { first: [1, 2], second: [1, 2] },
  ],
  [
    'nested references',
    'a = {"n": 1}\nb = [a, a]\nreturn [b, b]',
    'const a = {n:1}; const b = [a,a]; return [b,b];',
    [
      [{ n: 1 }, { n: 1 }],
      [{ n: 1 }, { n: 1 }],
    ],
  ],
]) {
  test(`Python accepts shared ${name} as the same JSON as JavaScript`, async () => {
    for (const [language, code] of [
      ['python', python],
      ['javascript', javascript],
    ]) {
      const result = await execute(language, code);
      assert.equal(result.kind, 'succeeded', JSON.stringify(result));
      assert.deepEqual(result.output, output);
    }
  });
}
for (const code of [
  'a = []\na.append(a)\nreturn a',
  'a = {}\na["self"] = a\nreturn a',
]) {
  test(`Python refuses an ancestor cycle: ${code.split('\n')[0]}`, async () => {
    const result = await execute('python', code);
    assert.equal(result.kind, 'failed');
    assert.equal(result.code, 'code.output_invalid');
  });
}
test('Python counts shared material against the JSON member bound', async () => {
  const result = await execute(
    'python',
    'a = list(range(100))\nreturn [a] * 101',
  );
  assert.equal(result.kind, 'failed');
  assert.equal(result.code, 'code.output_invalid');
  assert.match(JSON.stringify(result.diagnostics), /too many JSON members/);
});
test('Python counts shared material against the JSON byte bound', async () => {
  const result = await execute(
    'python',
    'a = {"text": "x" * 600000}\nreturn [a, a]',
  );
  assert.equal(result.kind, 'failed');
  assert.equal(result.code, 'code.output_invalid');
  assert.match(JSON.stringify(result.diagnostics), /JSON byte limit/);
});
