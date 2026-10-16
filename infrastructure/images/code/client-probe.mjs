import assert from 'node:assert/strict';
import { DEFAULT_CODE_SETTINGS } from '/workspace/packages/node-sdk/dist/index.js';
import { createCodeRunnerClient } from '/workspace/apps/worker/dist/attempts/code/client.js';

const client = createCodeRunnerClient({
  settings: DEFAULT_CODE_SETTINGS,
  socketPath: '/run/pertexo-code/runner.sock',
  requireHardened: true,
});
const task = (
  code,
  timeoutSeconds = 3,
  input = { amount: 3 },
  variables = { RATE: 2 },
) =>
  client.execute(
    { code, timeoutSeconds, input, variables },
    AbortSignal.timeout(15_000),
  );
try {
  assert.deepEqual(
    await task(
      "console.info('amount', input.amount); return {total:require('lodash').sum([input.amount,$vars.RATE]),year:require('dayjs')('2026-01-01').year()};",
    ),
    {
      kind: 'succeeded',
      output: { total: 5, year: 2026 },
      diagnostics: {
        logs: [{ level: 'info', message: 'amount 3' }],
        truncated: false,
      },
    },
  );
  const hostile = [
    ['network', "return require('net');", 'code.module_refused'],
    [
      'cached fs import',
      "await import('node:fs'); return true;",
      'code.module_refused',
    ],
    ['module loader', "return require('node:module');", 'code.module_refused'],
    [
      'fork',
      "return require('child_process').fork('bad');",
      'code.module_refused',
    ],
    ['loop', 'while(true) {}', 'code.timeout'],
    [
      'heap',
      "const list=[]; while(true) list.push(Array(100000).fill('value'));",
      'code.memory_limit',
    ],
    [
      'Buffer',
      "const list=[]; while(true) list.push(require('buffer').Buffer.alloc(16*1024*1024,1));",
      'code.memory_limit',
    ],
    [
      'ArrayBuffer',
      'const list=[]; while(true) {const b=new Uint8Array(16*1024*1024); b.fill(7); list.push(b)}',
      'code.memory_limit',
    ],
    [
      'SharedArrayBuffer',
      'const list=[]; while(true) {const b=new Uint8Array(new SharedArrayBuffer(16*1024*1024)); b.fill(7); list.push(b)}',
      'code.memory_limit',
    ],
    [
      'stack',
      'function recurse(){return recurse()} return recurse();',
      'code.runtime_error',
    ],
    ['cycle', 'const a={}; a.self=a; return a;', 'code.output_invalid'],
    ['giant output', "return 'x'.repeat(1048577);", 'code.output_invalid'],
    ['accessor', 'return {get data(){while(true){}}};', 'code.output_invalid'],
    [
      'proxy',
      'return new Proxy({}, {ownKeys(){while(true){}}});',
      'code.output_invalid',
    ],
  ];
  for (const [name, code, expected] of hostile) {
    const [bad, healthy] = await Promise.all([
      // Memory qualification needs time to reach the heap/RSS fence; the
      // independent loop probe still verifies the one-second deadline.
      task(code, expected === 'code.memory_limit' ? 10 : 1),
      task('return 42;'),
    ]);
    assert.equal(bad.kind, 'failed', name);
    assert.equal(bad.code, expected, name + ': ' + JSON.stringify(bad));
    assert.equal(healthy.kind, 'succeeded', `${name}: concurrent task`);
    assert.equal(healthy.output, 42, `${name}: concurrent output`);
  }
  assert.deepEqual(
    (
      await task(
        "return {process:typeof process,global:typeof global,fetch:typeof fetch,socket:typeof WebSocket,constructor:Function('return typeof process')(),loader:typeof require.cache};",
      )
    ).output,
    {
      process: 'undefined',
      global: 'undefined',
      fetch: 'undefined',
      socket: 'undefined',
      constructor: 'undefined',
      loader: 'undefined',
    },
  );
  assert.equal(
    (
      await task(
        "globalThis.workspaceSecret='A'; require('lodash').sum=()=>999; return true;",
      )
    ).kind,
    'succeeded',
  );
  assert.deepEqual(
    (
      await task(
        "return {leak:typeof workspaceSecret,sum:require('lodash').sum([2,3])};",
      )
    ).output,
    { leak: 'undefined', sum: 5 },
  );
  assert.equal(
    (
      await task(
        "Object.prototype.toJSON=()=> 'wrong'; Array.prototype.includes=()=>true; String.prototype.startsWith=()=>true; return {value:2};",
      )
    ).output.value,
    2,
  );
  assert.equal(
    (
      await task(
        "Array.prototype.includes=()=>true; String.prototype.startsWith=()=>true; return require('fs');",
      )
    ).code,
    'code.module_refused',
  );
  const logs = await task(
    "for(let i=0;i<1000;i++)console.log('line',i); return true;",
  );
  assert.equal(logs.kind, 'succeeded');
  assert.equal(logs.diagnostics.logs.length, 200);
  assert.equal(logs.diagnostics.truncated, true);
  const failure = await task(
    "console.warn('before');\nthrow new Error('private message');",
  );
  assert.equal(failure.code, 'code.runtime_error');
  assert.equal(failure.diagnostics.error.message, 'private message');
  assert.equal(failure.diagnostics.error.line, 2);
  const cancel = new AbortController();
  const canceled = client.execute(
    { code: 'while(true) {}', timeoutSeconds: 10, input: null, variables: {} },
    cancel.signal,
  );
  setTimeout(() => cancel.abort(), 100);
  await assert.rejects(canceled);
  const parallel = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      task('return input;', 3, index, {}),
    ),
  );
  assert.deepEqual(
    parallel.map((result) => result.output),
    Array.from({ length: 12 }, (_, index) => index),
  );
  assert.equal((await task('return input.amount*$vars.RATE;')).output, 6);
  console.log(
    'Hardened worker transport, hostile tasks, concurrent healthy tasks, cancellation and fresh-process isolation passed.',
  );
} finally {
  client.close();
}
