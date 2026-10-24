import { reserveProcess } from './support/reserve.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CODE_SETTINGS, type CodeResult } from '@pertexo/node-sdk';
import { createTaskProcessPool } from '../dist/process/pool.js';

describe('single-use Code processes', () => {
  let pool: Awaited<ReturnType<typeof createTaskProcessPool>>;
  beforeAll(async () => {
    pool = await createTaskProcessPool({
      settings: DEFAULT_CODE_SETTINGS,
      mode: 'process',
      socketPath: '/tmp/unused-code-test.sock',
    });
  });
  afterAll(async () => {
    await pool.close();
  });
  async function execute(
    code: string,
    timeoutSeconds = 2,
  ): Promise<CodeResult> {
    const slot = await reserveProcess(pool);
    try {
      return await slot.run(
        { code, timeoutSeconds, input: { amount: 3 }, variables: { RATE: 2 } },
        new AbortController().signal,
      );
    } finally {
      await slot.release();
    }
  }
  it('uses mapped JSON, captured variables, allowed packages and captured logs', async () => {
    expect(
      await execute(
        "console.info('amount', input.amount); return { total: require('lodash').sum([input.amount, $vars.RATE]), year: require('dayjs')('2026-01-01').year() };",
      ),
    ).toEqual({
      kind: 'succeeded',
      output: { total: 5, year: 2026 },
      diagnostics: {
        logs: [{ level: 'info', message: 'amount 3' }],
        truncated: false,
      },
    });
  });
  it.each([
    'fs',
    'node:fs',
    'node:fs/promises',
    'net',
    'http',
    'child_process',
    'module',
    'vm',
    'os',
    'worker_threads',
    'inspector',
    'v8',
    '../process/child.js',
    'data:text/javascript,export default 1',
    '@pertexo/node-sdk/server',
  ])('refuses require(%s)', async (name) => {
    expect(
      await execute(`return require(${JSON.stringify(name)});`),
    ).toMatchObject({ kind: 'failed', code: 'code.module_refused' });
  });
  it.each([
    'node:fs',
    'node:module',
    'node:child_process',
    'node:net',
    'data:text/javascript,export default 1',
  ])('refuses import(%s), including boot-cached modules', async (name) => {
    expect(
      await execute(`await import(${JSON.stringify(name)}); return true;`),
    ).toMatchObject({ kind: 'failed', code: 'code.module_refused' });
  });
  it('has no process or network globals through constructors', async () => {
    expect(
      await execute(
        "return { process: typeof process, global: typeof global, fetch: typeof fetch, socket: typeof WebSocket, constructor: Function('return typeof process')(), requireHandle: typeof require.cache };",
      ),
    ).toMatchObject({
      kind: 'succeeded',
      output: {
        process: 'undefined',
        global: 'undefined',
        fetch: 'undefined',
        socket: 'undefined',
        constructor: 'undefined',
        requireHandle: 'undefined',
      },
    });
  });
  it.each([
    'const a = {}; a.self = a; return a;',
    'return new Date();',
    'return undefined;',
    'return NaN;',
    'return 1n;',
    'return { get value() { while(true) {} } };',
    'return new Proxy({}, { ownKeys() { while(true) {} } });',
    'return new Array(100000000);',
    "return 'x'.repeat(1048577);",
    'return Object.assign([1], { extra: true });',
  ])(
    'rejects hostile/non-JSON output without invoking it: %s',
    async (source) => {
      expect(await execute(source)).toMatchObject({
        kind: 'failed',
        code: 'code.output_invalid',
      });
    },
  );
  it('caps logs visibly without changing the result', async () => {
    const result = await execute(
      "for(let i=0;i<500;i++) console.log('entry',i); return true;",
    );
    expect(result).toMatchObject({
      kind: 'succeeded',
      output: true,
      diagnostics: { truncated: true },
    });
    expect(result.diagnostics.logs).toHaveLength(200);
  });
  it('marks clipped log lines without dropping later lines', async () => {
    const result = await execute(
      "console.log('x'.repeat(5000)); console.info('later'); return true;",
    );
    expect(result).toMatchObject({
      kind: 'succeeded',
      diagnostics: { truncated: true },
    });
    expect(result.diagnostics.logs[0]?.message).toHaveLength(2048);
    expect(result.diagnostics.logs[1]).toEqual({
      level: 'info',
      message: 'later',
    });
  });
  it('retains NUL and malformed Unicode logs and errors as printable text', async () => {
    const result = await execute(
      'console.log(String.fromCharCode(0, 0xd800)); throw new Error(String.fromCharCode(0, 0xd800));',
    );
    expect(result.diagnostics.logs).toEqual([
      { level: 'log', message: '\\u0000�' },
    ]);
    expect(result.diagnostics.error?.message).toBe('\\u0000�');
  });
  it('keeps bounded messages and source locations private', async () => {
    expect(
      await execute(
        "console.warn('before');\nthrow new Error('user-only detail');",
      ),
    ).toMatchObject({
      kind: 'failed',
      code: 'code.runtime_error',
      diagnostics: {
        logs: [{ level: 'warn', message: 'before' }],
        error: { message: 'user-only detail', line: 2 },
      },
    });
  });
  it('terminates loops and starts the next task in a clean process', async () => {
    expect(await execute('while(true) {}', 1)).toMatchObject({
      kind: 'failed',
      code: 'code.timeout',
    });
    expect(await execute('return input.amount;')).toMatchObject({
      kind: 'succeeded',
      output: 3,
    });
  });
  it('does not leak globals, library mutation, or module cache to the next task', async () => {
    expect(
      await execute(
        "globalThis.privateValue = 'workspace A'; require('lodash').sum = () => 999; return true;",
      ),
    ).toMatchObject({ kind: 'succeeded' });
    expect(
      await execute(
        "return { leaked: typeof privateValue, sum: require('lodash').sum([2,3]) };",
      ),
    ).toMatchObject({
      kind: 'succeeded',
      output: { leaked: 'undefined', sum: 5 },
    });
  });
  it('kills cancellation and reuses the slot only after exit', async () => {
    const slot = await reserveProcess(pool);
    const cancel = new AbortController();
    const task = slot.run(
      {
        code: 'while(true) {}',
        timeoutSeconds: 10,
        input: null,
        variables: {},
      },
      cancel.signal,
    );
    setTimeout(() => {
      cancel.abort();
    }, 50);
    await expect(task).rejects.toThrow('canceled');
    await slot.release();
    expect(await execute('return true;')).toMatchObject({
      kind: 'succeeded',
      output: true,
    });
  });
  it('survives altered prototypes and never invokes a returned toJSON', async () => {
    expect(
      await execute(
        "Object.prototype.toJSON = () => 'stolen'; Array.prototype.includes = () => true; String.prototype.startsWith = () => true; return { value: 2 };",
      ),
    ).toMatchObject({ kind: 'succeeded', output: { value: 2 } });
    expect(
      await execute(
        "Array.prototype.includes = () => true; String.prototype.startsWith = () => true; return require('node:fs');",
      ),
    ).toMatchObject({ kind: 'failed', code: 'code.module_refused' });
  });
});
