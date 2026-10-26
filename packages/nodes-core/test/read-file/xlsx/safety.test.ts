import { randomBytes } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { readXlsxRecords } from '../../../src/data/read-file/xlsx/records.js';
import {
  entriesOf,
  readWorkbook,
  row,
  text,
  workbook,
  zip,
  type ZipEntry,
} from './workbook.fixture.js';

const tooLarge = { diagnostic: { reason: 'spreadsheet_too_large' } };
const unsupported = { diagnostic: { reason: 'unsupported_spreadsheet' } };
const sheet = { name: 'Sheet1', rows: row(1, text('A1', 0)) };
const valid = (extraEntries: readonly ZipEntry[] = []) =>
  workbook({ sharedStrings: ['a'], sheets: [sheet], extraEntries });

describe('Excel workbook safety', () => {
  it('refuses a zip bomb from its directory, before inflating anything', async () => {
    // The payload is not even deflate data: reaching it would report damage.
    const bomb = valid([
      {
        name: 'xl/media/image1.png',
        data: '',
        payload: randomBytes(1024),
        declaredSize: 104_857_601,
      },
    ]);
    await expect(readWorkbook(bomb)).rejects.toMatchObject(tooLarge);
  });

  it('stops inflating an entry that expands past its declared size', async () => {
    const zeros = Buffer.alloc(8 * 1024 * 1024);
    // The directory claims 1 KiB for a sheet that inflates to 8 MiB.
    const bomb = zip(
      entriesOf(valid()).map((entry) =>
        entry.name === 'xl/worksheets/sheet1.xml'
          ? { ...entry, payload: deflateRawSync(zeros), declaredSize: 1024 }
          : entry,
      ),
    );
    await expect(readWorkbook(bomb)).rejects.toMatchObject(tooLarge);
  });

  it('refuses more than 1,000 entries from the directory', async () => {
    const many = Array.from({ length: 1_000 }, (_, index) => ({
      name: `xl/media/${String(index)}.bin`,
      data: '',
      payload: randomBytes(4),
    }));
    await expect(readWorkbook(valid(many))).rejects.toMatchObject(tooLarge);
  });

  it('refuses more than 256 sheets', async () => {
    const sheets = Array.from({ length: 257 }, (_, index) => ({
      ...sheet,
      name: `S${String(index)}`,
    }));
    await expect(
      readWorkbook(workbook({ sharedStrings: ['a'], sheets })),
    ).rejects.toMatchObject(tooLarge);
  });

  it('stops after 1,000,000 cells, empty ones included', async () => {
    const cells = '<c/>'.repeat(16);
    const rows = `<row>${cells}</row>`.repeat(62_501);
    await expect(
      readWorkbook(workbook({ sheets: [{ name: 'Sheet1', rows }] })),
    ).rejects.toMatchObject(tooLarge);
  });

  it('counts merged-area fills toward the same cell budget', async () => {
    const names = Array.from({ length: 20 }, (_, index) => `c${String(index)}`);
    const header = names
      .map((_, index) => `<c t="s"><v>${String(index)}</v></c>`)
      .join('');
    const rows = Array.from(
      { length: 60_000 },
      (_, index) => `<row r="${String(index + 2)}"><c t="s"><v>0</v></c></row>`,
    ).join('');
    const bytes = workbook({
      sharedStrings: names,
      sheets: [
        {
          name: 'Sheet1',
          rows: `<row r="1">${header}</row>${rows}`,
          after: '<mergeCells><mergeCell ref="A2:T1048576"/></mergeCells>',
        },
      ],
    });
    // Drained as Output pages would, so the inline value limit can't intervene.
    const drain = async () => {
      for await (const _ of readXlsxRecords(
        bytes,
        { format: 'xlsx', headerRow: 1, convertValues: true },
        new AbortController().signal,
        { accept: () => undefined },
      ));
    };
    await expect(drain()).rejects.toMatchObject(tooLarge);
  });

  it.each([
    [
      'macro-enabled .xlsm',
      workbook({
        sharedStrings: ['a'],
        sheets: [sheet],
        workbookContentType:
          'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
      }),
    ],
    ['a VBA project', valid([{ name: 'xl/vbaProject.bin', data: 'macro' }])],
    [
      'legacy .xls and encrypted workbooks',
      Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), randomBytes(512)]),
    ],
    [
      'an OpenDocument spreadsheet',
      zip([
        {
          name: 'mimetype',
          data: 'application/vnd.oasis.opendocument.spreadsheet',
          stored: true,
        },
        { name: 'content.xml', data: '<office:document-content/>' },
      ]),
    ],
    ['a CSV file', Buffer.from('name,amount\nAda,12\n')],
    ['an empty file', Buffer.alloc(0)],
  ])('rejects %s with a hint to save as .xlsx', async (_, bytes) => {
    await expect(readWorkbook(bytes)).rejects.toMatchObject({
      ...unsupported,
      errorSummary: expect.stringContaining(
        'save it as Excel Workbook (.xlsx)',
      ) as unknown,
    });
  });

  it.each([
    ['a truncated file', valid().subarray(0, 900)],
    ['a checksum mismatch', corruptStoredEntry()],
    [
      'damaged deflate data',
      valid([
        {
          name: 'xl/worksheets/sheet1.xml',
          data: 'x',
          payload: randomBytes(64),
        },
      ]),
    ],
    [
      'an encrypted entry',
      zip(entriesOf(valid()).map((entry) => ({ ...entry, flags: 1 }))),
    ],
    [
      'a 2 MiB attribute',
      workbook({
        sheets: [
          { name: 'Sheet1', rows: `<row r="1" x="${'a'.repeat(2_097_152)}"/>` },
        ],
      }),
    ],
    [
      'deep nesting',
      workbook({ sheets: [{ name: 'Sheet1', rows: '<a>'.repeat(100) }] }),
    ],
    [
      'rows out of order',
      workbook({
        sharedStrings: ['a'],
        sheets: [
          {
            name: 'Sheet1',
            rows: row(2, text('A2', 0)) + row(1, text('A1', 0)),
          },
        ],
      }),
    ],
    [
      'a missing shared string',
      workbook({ sheets: [{ name: 'Sheet1', rows: row(1, text('A1', 7)) }] }),
    ],
  ])('rejects %s as damaged', async (_, bytes) => {
    await expect(readWorkbook(bytes)).rejects.toMatchObject(unsupported);
  });

  it('ignores external links and embedded objects instead of fetching them', async () => {
    const bytes = valid([
      {
        name: 'xl/externalLinks/externalLink1.xml',
        data: '<externalLink><externalBook r:id="rId1"/></externalLink>',
      },
      {
        name: 'xl/externalLinks/_rels/externalLink1.xml.rels',
        data: '<Relationships><Relationship Id="rId1" Target="http://127.0.0.1:9/book.xlsx" TargetMode="External"/></Relationships>',
      },
      { name: 'xl/embeddings/oleObject1.bin', data: randomBytes(256) },
    ]);
    const result = await readWorkbook(bytes);
    expect(result).toMatchObject({ kind: 'succeeded', output: [] });
  });
});

function corruptStoredEntry(): Buffer {
  const bytes = zip(
    entriesOf(valid()).map((entry) =>
      entry.name === 'xl/workbook.xml' ? { ...entry, stored: true } : entry,
    ),
  );
  bytes[bytes.indexOf('<sheets>') + 1] = 'S'.charCodeAt(0);
  return bytes;
}
