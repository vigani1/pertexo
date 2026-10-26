import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeflateRaw } from 'node:zlib';
import { afterAll, expect, it } from 'vitest';
import { entriesOf, workbook, zip } from './workbook.fixture.js';

const directory = mkdtempSync(join(tmpdir(), 'pertexo-xlsx-memory-'));
afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

function probe(bytes: Buffer) {
  const file = join(directory, `${String(Math.random()).slice(2)}.xlsx`);
  writeFileSync(file, bytes);
  const moduleUrl = new URL(
    '../../../dist/data/read-file/xlsx/records.js',
    import.meta.url,
  ).href;
  const script = `
    import { readFileSync } from 'node:fs';
    const { readXlsxRecords } = await import(${JSON.stringify(moduleUrl)});
    const bytes = readFileSync(${JSON.stringify(file)});
    let count = 0, reason;
    const high = { heapUsed: 0, rss: 0 };
    const sample = () => {
      const memory = process.memoryUsage();
      high.heapUsed = Math.max(high.heapUsed, memory.heapUsed);
      high.rss = Math.max(high.rss, memory.rss);
    };
    const started = performance.now();
    try {
      const config = { format: 'xlsx', headerRow: 1, convertValues: true };
      for await (const _ of readXlsxRecords(bytes, config, new AbortController().signal, { accept: (row) => row })) {
        if (++count % 1000 === 0) sample();
      }
    } catch (error) {
      if (error.safeErrorCode !== 'execution.file_input') throw error;
      reason = error.diagnostic.reason;
    }
    sample();
    console.log(JSON.stringify({ count, reason, high, millis: performance.now() - started }));
  `;
  const result = spawnSync(
    process.execPath,
    ['--max-old-space-size=64', '--input-type=module', '--eval', script],
    { encoding: 'utf8', timeout: 60_000, maxBuffer: 65_536 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as {
    count: number;
    reason?: string;
    high: { heapUsed: number; rss: number };
    millis: number;
  };
}

/** Deflates a run of zeros without ever holding it uncompressed. */
async function deflatedZeros(bytes: number): Promise<Buffer> {
  const deflate = createDeflateRaw({ level: 9 });
  const output: Buffer[] = [];
  deflate.on('data', (chunk: Buffer) => output.push(chunk));
  const block = Buffer.alloc(1024 * 1024);
  for (let written = 0; written < bytes; written += block.length)
    if (!deflate.write(block))
      await new Promise((resolve) => deflate.once('drain', resolve));
  await new Promise((resolve) => deflate.end(resolve));
  return Buffer.concat(output);
}

const MIB = 1024 * 1024;

it('streams 300,000 rows within a 64 MiB heap without retaining them', () => {
  const rows = Array.from(
    { length: 300_000 },
    (_, index) =>
      `<row r="${String(index + 2)}"><c r="A${String(index + 2)}"><v>${String(index)}</v></c><c r="B${String(index + 2)}" t="inlineStr"><is><t>item ${String(index)}</t></is></c><c r="C${String(index + 2)}" t="b"><v>1</v></c></row>`,
  ).join('');
  const result = probe(
    workbook({
      sharedStrings: ['id', 'name', 'paid'],
      sheets: [
        {
          name: 'Sheet1',
          rows: `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>${rows}`,
        },
      ],
    }),
  );
  expect(result).toMatchObject({ count: 300_000 });
  expect(result.reason).toBeUndefined();
  expect(result.high.heapUsed).toBeLessThan(64 * MIB);
  console.info('F51 workbook streaming baseline', result);
}, 90_000);

it('refuses a sheet that hides 1 GiB behind a 1 KiB directory size, inflating at most that 1 KiB', async () => {
  const valid = workbook({
    sheets: [{ name: 'Sheet1', rows: '' }],
  });
  const payload = await deflatedZeros(1024 * MIB);
  const result = probe(
    zip([
      ...entriesOf(valid).filter(
        (entry) => entry.name !== 'xl/worksheets/sheet1.xml',
      ),
      {
        name: 'xl/worksheets/sheet1.xml',
        data: Buffer.alloc(1024),
        payload,
        declaredSize: 1024,
      },
    ]),
  );
  expect(result.reason).toBe('spreadsheet_too_large');
  expect(result.high.heapUsed).toBeLessThan(64 * MIB);
  expect(result.millis).toBeLessThan(5_000);
}, 90_000);

it.each([
  [
    'more than 1,000,000 cells',
    `<row>${Array.from({ length: 16 }, (_, index) => `<c t="inlineStr"><is><t>c${String(index)}</t></is></c>`).join('')}</row>` +
      `<row>${'<c><v>1</v></c>'.repeat(16)}</row>`.repeat(62_500),
    'spreadsheet_too_large',
  ],
  [
    'a 48 MiB attribute',
    `<row r="1" x="${'a'.repeat(48 * MIB)}"/>`,
    'unsupported_spreadsheet',
  ],
])(
  'refuses %s within a 64 MiB heap',
  (_, rows, reason) => {
    const result = probe(workbook({ sheets: [{ name: 'Sheet1', rows }] }));
    expect(result.reason).toBe(reason);
    expect(result.count).toBeLessThan(62_500);
    expect(result.high.heapUsed).toBeLessThan(64 * MIB);
  },
  90_000,
);
