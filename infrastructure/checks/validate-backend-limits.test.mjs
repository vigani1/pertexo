import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  LIMITS_CHECKED,
  findWrittenLimits,
  inspectBackendLimits,
  validateLimitsChecked,
  validateBackendLimits,
  BYTE_SIZE_OWNER,
  findHandWrittenByteUnits,
} from './validate-backend-limits.mjs';
import { NOT_LIMITS } from './backend-limit-exemptions.mjs';

const find = (text) => findWrittenLimits('a.ts', text);

test('finds a limit written in logic or as a duration string', () => {
  assert.deepEqual(find('if (bytes > 4_096) throw error;'), ['4096']);
  assert.deepEqual(find('z.string().max(128);'), ['128']);
  assert.deepEqual(find("schedule({ every: '30s' });"), ["'30s'"]);
  assert.deepEqual(find('setTimeout(run, 250);'), ['250']);
  assert.deepEqual(find('const timeout = 5_000;'), ['5000']);
});

test('leaves named constants, unit factors, bit layouts and types alone', () => {
  assert.deepEqual(
    find(
      [
        'const MAX_BYTES = 4_096;',
        'const LIMITS = Object.freeze({ bytes: 2_048, nested: [16, 32] });',
        'const seconds = milliseconds / 1_000;',
        'const minutes = 5 * 60;',
        'const word = (value >>> 16) & 0xffff;',
        'const first = list[2];',
        'type Pair = readonly [0, 1];',
        'const one = items.length - 1;',
      ].join('\n'),
    ),
    ['5'],
  );
});

test('allows a listed literal or file and refuses a stale entry', () => {
  const [listed] = Object.keys(NOT_LIMITS).filter((key) => !key.endsWith('*'));
  const [file, literal] = listed.split(': ');
  const wholeFile = Object.keys(NOT_LIMITS)
    .find((key) => key.endsWith(': *'))
    .slice(0, -': *'.length);
  const everyEntry = Object.keys(NOT_LIMITS).map((key) => {
    const [entryFile, entryLiteral] = key.split(': ');
    return [entryFile, [entryLiteral === '*' ? '7' : entryLiteral]];
  });
  assert.deepEqual(validateBackendLimits(everyEntry), []);
  assert.deepEqual(
    validateBackendLimits([...everyEntry, [wholeFile, ['99']]]),
    [],
  );
  assert.match(
    validateBackendLimits([...everyEntry, [file, ['12345']]]).join(),
    /: 12345: name this limit/u,
  );
  assert.match(
    validateBackendLimits(
      everyEntry.filter(([f, [l]]) => !(f === file && l === literal)),
    ).join(),
    /no longer written; remove it from NOT_LIMITS/u,
  );
});

test('scans the reworked packages from disk', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'backend-limits-'));
  const [workspace] = LIMITS_CHECKED;
  try {
    await mkdir(path.join(root, workspace, 'src'), { recursive: true });
    await writeFile(
      path.join(root, workspace, 'src/retry.ts'),
      'export const wait = () => sleep(1_500);',
    );
    assert.ok(
      (await inspectBackendLimits(root)).some((finding) =>
        finding.startsWith(`${workspace}/src/retry.ts: 1500: name this limit`),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('finds a limit written into text', () => {
  assert.deepEqual(find("const hint = 'use 100 to 30000 milliseconds';"), [
    '"30000 milliseconds"',
  ]);
  assert.deepEqual(find('const hint = `a ${kind} key of 32-byte length`;'), [
    '"32-byte"',
  ]);
  assert.deepEqual(find("const hint = 'runs stop after five minutes';"), [
    '"five minutes"',
  ]);
  assert.deepEqual(
    find('const hint = `at most ${String(MAX)} characters`;'),
    [],
  );
  assert.deepEqual(
    find('const hint = `at most ${String(MAX)} UTF-8 bytes, not 8 bytes`;'),
    ['"8 bytes"'],
  );
});

test('names a limit only at module level, not in a function body', () => {
  assert.deepEqual(
    find('export function wait() { const DELAY_MS = 2_500; return DELAY_MS; }'),
    ['2500'],
  );
});

test('refuses dropping a reworked package from the check', () => {
  assert.deepEqual(validateLimitsChecked(LIMITS_CHECKED), []);
  assert.match(
    validateLimitsChecked(LIMITS_CHECKED.slice(1)).join(),
    /LIMITS_CHECKED may only grow/u,
  );
});

test('refuses a byte unit written after a computed size, outside the formatter', () => {
  const text =
    'const a = `fits ${String(bytes / 1_024)} KB`; const b = `of ${count} items`;';
  assert.deepEqual(findHandWrittenByteUnits('packages/x/src/a.ts', text), [
    'packages/x/src/a.ts: "${…} KB": write byte sizes with formatByteSize (packages/node-sdk/src/values/byte-size.ts).',
  ]);
  assert.deepEqual(findHandWrittenByteUnits(BYTE_SIZE_OWNER, text), []);
});

test('leaves an HTTP status where HTTP code writes one, and nothing else', () => {
  const find = (text) => findWrittenLimits('packages/x/src/a.ts', text);
  assert.deepEqual(
    find(
      'if (response.status === 404 || statusCode >= 500) f(); const p = { status: 409 }; const r = { responses: { 200: ok } };',
    ),
    [],
  );
  assert.deepEqual(find('const wait = sleep(500); const max = limit > 404;'), [
    '500',
    '404',
  ]);
  assert.deepEqual(find('if (response.status === 600) f();'), ['600']);
});
