import { createHash } from 'node:crypto';

import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import {
  NodeExecutorFailure,
  type NodeExecutionRuntime,
} from '@pertexo/node-sdk/server';

import { createCoreNodeRegistry } from '../../src/server.js';
import { workbook } from './xlsx/workbook.fixture.js';

const registry = createCoreNodeRegistry();
const READ_FILE = { key: 'core.read_file', version: 1 };
const XML = { key: 'core.xml', version: 1 };

function runtime(bytes: Uint8Array): NodeExecutionRuntime {
  return {
    workspaceId: 'workspace',
    runId: 'run',
    nodeRunId: 'node-run',
    attemptId: 'attempt',
    attemptNumber: 1,
    nodeId: 'read',
    invocationKey: 'root',
    sideEffectClass: 'safe',
    beforeDispatch: vi.fn(),
    artifacts: {
      read: vi.fn().mockResolvedValue(Uint8Array.from(bytes)),
      write: vi.fn(),
    },
  };
}

function readFile(bytes: Uint8Array, config: unknown) {
  return registry.execute({
    definition: READ_FILE,
    executor: READ_FILE,
    config,
    input: {
      file: {
        kind: 'artifact',
        artifactId: '11111111-1111-4111-8111-111111111111',
        byteLength: bytes.length,
        mediaType: 'application/octet-stream',
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    },
    signal: new AbortController().signal,
    runtime: runtime(bytes),
  });
}

/**
 * A hostile file ends as a step result: its rows, or the executor's own failure
 * with a safe code. Anything else escaping is a parser crash.
 */
async function expectStepResult(run: () => Promise<unknown>): Promise<void> {
  try {
    expect(await run()).toEqual(expect.objectContaining({ kind: 'succeeded' }));
  } catch (error: unknown) {
    if (!(error instanceof NodeExecutorFailure)) throw error;
    expect(error.safeErrorCode).toMatch(/^[a-z_.]+$/u);
  }
}

const CSV_PIECES = [
  ',',
  ';',
  '\t',
  '"',
  '""',
  '\n',
  '\r\n',
  '\r',
  '﻿',
  '\0',
  '=cmd()',
  '__proto__',
  'constructor',
  'a',
  '1',
  '1e999',
  '😀',
];
const JSON_PIECES = [
  '{',
  '}',
  '[',
  ']',
  ':',
  ',',
  '"',
  '"__proto__"',
  '"a"',
  '1',
  '1e999',
  'null',
  'true',
  '\\',
  '﻿',
  '\0',
];
const XML_PIECES = [
  '<a>',
  '</a>',
  '<a b="c">',
  '<a b="1" b="2">',
  '<',
  '>',
  '/>',
  '&',
  '&amp;',
  '&#0;',
  '&#xFFFFFFFF;',
  '&lol;',
  '<![CDATA[',
  ']]>',
  '<!--',
  '-->',
  '<?xml version="1.0"?>',
  '<?pi?>',
  '<!DOCTYPE a [<!ENTITY lol "lol">]>',
  '<__proto__>',
  '</__proto__>',
  'x:y',
  'text',
];

function pieces(from: readonly string[]) {
  return fc
    .array(fc.constantFrom(...from), { maxLength: 200 })
    .map((items) => items.join(''));
}

/** A real workbook with bytes changed, spliced out or added. */
const damagedWorkbook = fc
  .tuple(
    fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), {
      minLength: 1,
      maxLength: 24,
    }),
    fc.nat(),
    fc.nat({ max: 512 }),
  )
  .map(([changes, cut, length]) => {
    const valid = workbook({
      sheets: [
        {
          name: 'Sheet1',
          rows: '<row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2"><v>1</v></c></row>',
        },
      ],
      sharedStrings: ['amount'],
    });
    for (const [position, value] of changes)
      valid[position % valid.length] = value;
    const at = cut % valid.length;
    return Buffer.concat([valid.subarray(0, at), valid.subarray(at + length)]);
  });

/** A well-formed zip whose parts hold hostile XML, so the bytes reach the cell reader. */
const hostileWorkbookParts = fc
  .record({
    rows: pieces([
      ...XML_PIECES,
      '<row r="1">',
      '</row>',
      '<c r="A1">',
      '</c>',
      '<v>',
      '</v>',
    ]),
    part: pieces(XML_PIECES),
    sharedItems: pieces([...XML_PIECES, '<si>', '</si>', '<t>', '</t>']),
    wholePart: fc.boolean(),
  })
  .map(({ rows, part, sharedItems, wholePart }) =>
    workbook({
      sheets: [{ name: 'Sheet1', ...(wholePart ? { part } : { rows }) }],
      sharedItems,
    }),
  );

const RUNS = { numRuns: 300 } as const;

describe('file parsers given hostile files', () => {
  it('reads any bytes as a CSV to a step result', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.uint8Array({ maxLength: 2_048 }),
          pieces(CSV_PIECES).map((text) => Buffer.from(text)),
        ),
        fc.constantFrom(',', ';', '\t'),
        fc.boolean(),
        async (bytes, delimiter, convertValues) => {
          await expectStepResult(() =>
            readFile(bytes, { format: 'csv', delimiter, convertValues }),
          );
        },
      ),
      RUNS,
    );
  }, 60_000);

  it('reads any bytes as JSON to a step result', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.uint8Array({ maxLength: 2_048 }),
          pieces(JSON_PIECES).map((text) => Buffer.from(text)),
          fc
            .integer({ min: 1, max: 100_000 })
            .map((depth) => Buffer.from('['.repeat(depth))),
        ),
        async (bytes) => {
          await expectStepResult(() => readFile(bytes, { format: 'json' }));
        },
      ),
      RUNS,
    );
  }, 60_000);

  it('reads any bytes and damaged workbooks as a spreadsheet to a step result', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.uint8Array({ maxLength: 2_048 }),
          damagedWorkbook,
          hostileWorkbookParts,
        ),
        async (bytes) => {
          await expectStepResult(() =>
            readFile(bytes, {
              format: 'xlsx',
              headerRow: 1,
              convertValues: true,
            }),
          );
        },
      ),
      RUNS,
    );
  }, 120_000);

  it('parses any text as XML to a step result', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.string({ maxLength: 512 }),
          pieces(XML_PIECES),
          fc
            .integer({ min: 1, max: 20_000 })
            .map((depth) => '<a>'.repeat(depth)),
        ),
        async (value) => {
          await expectStepResult(() =>
            registry.execute({
              definition: XML,
              executor: XML,
              config: { operation: 'parse' },
              input: { value },
              signal: new AbortController().signal,
              runtime: runtime(new Uint8Array()),
            }),
          );
        },
      ),
      RUNS,
    );
  }, 60_000);
});
