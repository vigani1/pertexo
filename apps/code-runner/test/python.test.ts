import { reserveProcess } from './support/reserve.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CODE_SETTINGS, type CodeResult } from '@pertexo/node-sdk';
import { createTaskProcessPool } from '../dist/process/pool.js';

describe('single-use Python Code processes', () => {
  let pool: Awaited<ReturnType<typeof createTaskProcessPool>>;
  beforeAll(async () => {
    pool = await createTaskProcessPool({
      settings: DEFAULT_CODE_SETTINGS,
      mode: 'process',
      socketPath: '/tmp/unused-python-test.sock',
    });
  });
  afterAll(async () => {
    await pool.close();
  });
  it.each(['os', 'pertexo_missing_package'])(
    'refuses invalid administrator extras at runner startup: %s',
    async (name) => {
      await expect(
        createTaskProcessPool({
          settings: { ...DEFAULT_CODE_SETTINGS, pythonPackages: [name] },
          mode: 'process',
          socketPath: '/tmp/unused-python-policy.sock',
        }),
      ).rejects.toThrow('initialize its module policy');
    },
  );
  async function execute(
    code: string,
    timeoutSeconds = 2,
  ): Promise<CodeResult> {
    const slot = await reserveProcess(pool);
    try {
      return await slot.run(
        {
          language: 'python',
          code,
          timeoutSeconds,
          input: { amount: 3 },
          variables: { RATE: 2 },
        },
        new AbortController().signal,
      );
    } finally {
      await slot.release();
    }
  }
  it('uses mapped input, variables, stdlib, timezone data and private print diagnostics', async () => {
    expect(
      await execute(`import json, math, statistics, datetime, zoneinfo, re, decimal, fractions
import itertools, functools, collections, string, textwrap, hashlib, hmac, base64, uuid, random, html, csv
from urllib import parse
print("amount", input["amount"])
return {"total": input["amount"] * _vars["RATE"], "zone": zoneinfo.ZoneInfo("Europe/Paris").key, "sum": statistics.mean([2, 4]), "query": parse.quote("a b")}`),
    ).toMatchObject({
      kind: 'succeeded',
      output: { total: 6, zone: 'Europe/Paris', sum: 3, query: 'a%20b' },
      diagnostics: {
        logs: [{ level: 'log', message: 'amount 3' }],
        truncated: false,
      },
    });
  });
  it('supports datetime parsing/formatting and CSV text buffers', async () => {
    expect(
      await execute(
        'from datetime import datetime\nimport csv, io\nreturn {"date": datetime.strptime("22/10/2026", "%d/%m/%Y").strftime("%Y-%m-%d"), "rows": list(csv.DictReader(io.StringIO("name,value\\nAda,2\\n")))}',
      ),
    ).toMatchObject({
      kind: 'succeeded',
      output: { date: '2026-10-22', rows: [{ name: 'Ada', value: '2' }] },
    });
  });
  it('bounds blocking standard-library waits beside a healthy task', async () => {
    const [waiting, healthy] = await Promise.all([
      execute('import time\ntime.sleep(10)\nreturn True', 1),
      execute('return input["amount"]'),
    ]);
    expect(waiting).toMatchObject({ kind: 'failed', code: 'code.timeout' });
    expect(healthy).toMatchObject({ kind: 'succeeded', output: 3 });
  });
  it.each([
    'os',
    'sys',
    'subprocess',
    'socket',
    'ctypes',
    'threading',
    'multiprocessing',
    'importlib',
    'pickle',
    'asyncio',
    'urllib.request',
    'pathlib',
  ])('refuses %s clearly', async (name) => {
    const result = await execute(`import ${name}\nreturn True`);
    expect(result).toMatchObject({
      kind: 'failed',
      code: 'code.module_refused',
    });
    expect(result.diagnostics.error?.message).toContain(name);
  });
  it.each([
    'return float("nan")',
    'return float("inf")',
    'return {1: "value"}',
    'return (1, 2)',
    'return {1, 2}',
    'return 9007199254740992',
    'return object()',
    'return "x" * 1048577',
    'return [0] * 10001',
    'a = []\na.append(a)\nreturn a',
  ])('refuses non-JSON or oversized output: %s', async (source) => {
    expect(await execute(source)).toMatchObject({
      kind: 'failed',
      code: 'code.output_invalid',
    });
  });
  it('does not invoke custom output conversion hooks', async () => {
    expect(
      await execute(
        'class Hostile:\n    def __str__(self):\n        while True: pass\nreturn Hostile()',
      ),
    ).toMatchObject({ kind: 'failed', code: 'code.output_invalid' });
  });
  it('uses UTF-8 output bytes and bounds UTF-16 diagnostic characters', async () => {
    const result = await execute('print("😀" * 5000)\nreturn "é" * 500000');
    expect(result.kind).toBe('succeeded');
    if (result.kind === 'succeeded')
      expect(result.output).toBe('é'.repeat(500000));
    expect(result.diagnostics.logs[0]?.message).toHaveLength(2048);
    expect(result.diagnostics.truncated).toBe(true);
  });
  it('reports body-relative syntax and runtime positions', async () => {
    expect(await execute('value = 1\nreturn (')).toMatchObject({
      kind: 'failed',
      code: 'code.syntax_error',
      diagnostics: { error: { line: 2 } },
    });
    expect(
      await execute('value = 1\nraise ValueError("private detail")'),
    ).toMatchObject({
      kind: 'failed',
      code: 'code.runtime_error',
      diagnostics: { error: { line: 2, message: 'private detail' } },
    });
  });
  it('preserves multiline string contents in a function body', async () => {
    expect(await execute('return """first\nsecond"""')).toMatchObject({
      kind: 'succeeded',
      output: 'first\nsecond',
    });
    expect(await execute('return "first\u2028second"')).toMatchObject({
      kind: 'succeeded',
      output: 'first\u2028second',
    });
  });
  it('reports Unicode columns in the same UTF-16 coordinates as the editor', async () => {
    const source = 'text = "é😀"; raise ValueError("private detail")';
    expect(await execute(source)).toMatchObject({
      kind: 'failed',
      code: 'code.runtime_error',
      diagnostics: { error: { line: 1, column: source.indexOf('raise') + 1 } },
    });
    const syntax = 'text = "😀"; return (';
    expect(await execute(syntax)).toMatchObject({
      kind: 'failed',
      code: 'code.syntax_error',
      diagnostics: { error: { line: 1, column: syntax.lastIndexOf('(') + 1 } },
    });
  });
  it('locates a SyntaxError raised by user code at the runtime statement', async () => {
    expect(
      await execute('value = 1\nraise SyntaxError("private detail")'),
    ).toMatchObject({
      kind: 'failed',
      code: 'code.runtime_error',
      diagnostics: { error: { line: 2, message: 'private detail' } },
    });
  });
  it('bounds print lines and preserves later unclipped entries', async () => {
    const result = await execute(
      'print("x" * 5000)\nprint("later")\nreturn True',
    );
    expect(result).toMatchObject({
      kind: 'succeeded',
      diagnostics: { truncated: true },
    });
    expect(result.diagnostics.logs[0]?.message).toHaveLength(2048);
    expect(result.diagnostics.logs[1]?.message).toBe('later');
    const many = await execute('for i in range(500): print(i)\nreturn True');
    expect(many.diagnostics.logs).toHaveLength(200);
    expect(many.diagnostics.truncated).toBe(true);
  });
  it('keeps module mutation and globals out of the next process', async () => {
    expect(
      await execute(
        'import math\nmath.sqrt = lambda x: 999\nglobals()["secret"] = "private"\nreturn True',
      ),
    ).toMatchObject({ kind: 'succeeded' });
    expect(
      await execute(
        'import math\nreturn {"root": math.sqrt(9), "leaked": "secret" in globals()}',
      ),
    ).toMatchObject({ kind: 'succeeded', output: { root: 3, leaked: false } });
  });
  it('times out a CPU loop without blocking a healthy task in the shared pool', async () => {
    const [bomb, healthy] = await Promise.all([
      execute('while True: pass', 1),
      execute('return input["amount"]'),
    ]);
    expect(bomb).toMatchObject({ kind: 'failed', code: 'code.timeout' });
    expect(healthy).toMatchObject({ kind: 'succeeded', output: 3 });
  });
  it('reaps canceled Python and prevents reuse of a reservation', async () => {
    const slot = await reserveProcess(pool);
    const controller = new AbortController();
    const pending = slot.run(
      {
        language: 'python',
        code: 'while True: pass',
        timeoutSeconds: 10,
        input: null,
        variables: {},
      },
      controller.signal,
    );
    setTimeout(() => {
      controller.abort();
    }, 200);
    await expect(pending).rejects.toThrow();
    await slot.release();
    await expect(
      slot.run(
        { code: 'return true;', timeoutSeconds: 1, input: null, variables: {} },
        new AbortController().signal,
      ),
    ).rejects.toThrow('single-use');
    expect(await execute('return True')).toMatchObject({
      kind: 'succeeded',
      output: true,
    });
  });
  it('fails fast when the runtime floods its diagnostic stream past the log limit', async () => {
    // Each invalid escape makes CPython print a SyntaxWarning to stderr, so
    // a thousand of them write well over the 64 KiB log limit.
    const flood = Array.from(
      { length: 1000 },
      (_, line) => `v${String(line)} = "\\d"`,
    );
    expect(await execute(`${flood.join('\n')}\nreturn True`)).toMatchObject({
      kind: 'failed',
      code: 'code.output_invalid',
    });
  });
});
