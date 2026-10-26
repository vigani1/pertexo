import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { filePageBundleSchema } from '@pertexo/node-sdk';
import { createCoreNodeRegistry } from '../../src/server.js';
import { encodeFile } from '../../src/data/create-file/encode.js';
import { files } from '../read-file/artifacts.fixture.js';
import { entriesOf, readWorkbook } from '../read-file/xlsx/workbook.fixture.js';

const registry = createCoreNodeRegistry();
const XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function run(
  state: ReturnType<typeof files>,
  key: 'create_file' | 'read_file',
  config: unknown,
  input: unknown,
) {
  const identity = { key: `core.${key}`, version: 1 };
  return registry.execute({
    definition: identity,
    executor: identity,
    config,
    input,
    signal: new AbortController().signal,
    runtime: state.runtime,
  });
}

async function create(config: Record<string, unknown>, data: unknown) {
  const state = files();
  const result = await run(
    state,
    'create_file',
    { format: 'xlsx', columns: [], ...config },
    { data },
  );
  if (result.kind !== 'succeeded') throw new Error('Create failed');
  const { file } = result.output as {
    file: { artifactId: string; mediaType: string };
  };
  const bytes = state.get(file.artifactId);
  const parts = new Map(
    entriesOf(bytes).map((entry) => [
      entry.name,
      Buffer.from(entry.data).toString(),
    ]),
  );
  return {
    state,
    file,
    bytes,
    parts,
    sheet: parts.get('xl/worksheets/sheet1.xml') ?? '',
  };
}

const orders = [
  { name: 'Ada', amount: 12.5, paid: true, tags: ['vip'], note: null },
  { name: 'Grace', amount: -2, paid: false, extra: 'ignored' },
];

describe('Create file with Excel workbooks', () => {
  it('writes the chosen columns in order under a bold, frozen header', async () => {
    const { file, parts, sheet } = await create(
      {
        columns: ['paid', 'name', 'amount', 'missing'],
        sheetName: 'Orders 2026',
      },
      orders,
    );
    expect(file.mediaType).toBe(XLSX);
    expect(parts.get('xl/workbook.xml')).toContain(
      '<sheet name="Orders 2026" sheetId="1"',
    );
    expect(sheet).toContain(
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>',
    );
    expect(sheet).toContain(
      '<row r="1"><c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">paid</t></is></c><c r="B1" t="inlineStr" s="1">',
    );
    expect(sheet).toContain(
      '<row r="2"><c r="A2" t="b"><v>1</v></c><c r="B2" t="inlineStr"><is><t xml:space="preserve">Ada</t></is></c><c r="C2"><v>12.5</v></c></row>',
    );
    expect(parts.get('xl/styles.xml')).toContain('<font><b/>');
  });

  it('discovers columns in first-seen order and names the default sheet Sheet1', async () => {
    const { parts, state, file } = await create({}, orders);
    expect(parts.get('xl/workbook.xml')).toContain('<sheet name="Sheet1"');
    const read = await run(state, 'read_file', { format: 'xlsx' }, { file });
    expect(read).toMatchObject({
      kind: 'succeeded',
      output: [
        {
          name: 'Ada',
          amount: 12.5,
          paid: true,
          tags: '["vip"]',
          note: '',
          extra: '',
        },
        {
          name: 'Grace',
          amount: -2,
          paid: false,
          tags: '',
          note: '',
          extra: 'ignored',
        },
      ],
    });
  });

  it('keeps formula-like text as text, protected against later edits', async () => {
    const { sheet, state, file } = await create({}, [
      { value: '=HYPERLINK("http://example.test")' },
      { value: '+1' },
      { value: '-2' },
      { value: '@SUM(A1)' },
    ]);
    expect(sheet).not.toContain('<f>');
    expect(sheet).toContain(
      '<c r="A2" t="inlineStr" s="2"><is><t xml:space="preserve">=HYPERLINK(&quot;http://example.test&quot;)</t></is></c>',
    );
    const read = await run(state, 'read_file', { format: 'xlsx' }, { file });
    expect(read).toMatchObject({
      output: [
        { value: '=HYPERLINK("http://example.test")' },
        { value: '+1' },
        { value: '-2' },
        { value: '@SUM(A1)' },
      ],
    });
  });

  it('round-trips text Excel must escape, numbers, booleans and JSON cells', async () => {
    const rows = [
      {
        text: 'tab\tline\r\nnext\u0001 _x0041_ & <b> "q" 😀',
        big: Number.MAX_SAFE_INTEGER,
        huge: 1e21,
        small: 0.1,
        flag: false,
        nested: { a: [1, 'two'] },
      },
    ];
    const { state, file } = await create({}, rows);
    const read = await run(state, 'read_file', { format: 'xlsx' }, { file });
    expect(read).toMatchObject({
      output: [
        {
          text: 'tab\tline\r\nnext\u0001 _x0041_ & <b> "q" 😀',
          big: Number.MAX_SAFE_INTEGER,
          // As in CSV, integers past the safe range come back as their text.
          huge: '1e+21',
          small: 0.1,
          flag: false,
          nested: '{"a":[1,"two"]}',
        },
      ],
    });
  });

  it('writes the same bytes for the same rows', async () => {
    const first = await create({}, orders);
    const second = await create({}, orders);
    expect(first.bytes.equals(second.bytes)).toBe(true);
  });

  it.each([
    [{ sheetName: 'a/b' }],
    [{ sheetName: "'quoted'" }],
    [{ sheetName: 'x'.repeat(32) }],
    [{ sheetName: '' }],
  ])('refuses an Excel sheet name Excel would refuse (%j)', async (config) => {
    await expect(create(config, orders)).rejects.toBeDefined();
  });

  it.each([
    [[{ value: 'x'.repeat(32_768) }], 'file.create_data', '32,767 characters'],
    ['not rows', 'file.create_data', 'Excel needs a list of objects'],
    [[[1, 2]], 'file.create_data', 'Excel row 1 needs an object'],
  ])(
    'refuses data a workbook cannot hold (%#)',
    async (data, code, summary) => {
      await expect(create({}, data)).rejects.toMatchObject({
        safeErrorCode: code,
        errorSummary: expect.stringContaining(summary) as unknown,
      });
    },
  );

  it('refuses a workbook over 1 MB inline before storing it', async () => {
    // Step input can't reach this; random text keeps the archive from shrinking.
    const rows = Array.from({ length: 3_000 }, () => ({
      value: randomBytes(500).toString('base64'),
    }));
    await expect(
      encodeFile(
        { format: 'xlsx', sheetName: 'Sheet1', columns: [] },
        rows,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ safeErrorCode: 'file.create_size' });
  });

  it('streams pages into one workbook and reads them back as pages', async () => {
    const state = files();
    const csv = state.add(
      Buffer.from(
        'id,currency,amount\r\n' +
          Array.from(
            { length: 2_500 },
            (_, id) =>
              `${String(id)},${id % 2 === 0 ? 'EUR' : 'USD'},${String(id / 4)}\r\n`,
          ).join(''),
      ),
      'text/csv',
    );
    const paged = await run(
      state,
      'read_file',
      { format: 'csv', delimiter: ',', outputMode: 'pages' },
      { file: csv },
    );
    if (paged.kind !== 'succeeded') throw new Error('Read failed');
    const { pages } = filePageBundleSchema.parse(paged.output);
    await expect(
      run(
        state,
        'create_file',
        { format: 'xlsx', inputMode: 'pages', columns: [] },
        { pages },
      ),
    ).rejects.toMatchObject({ safeErrorCode: 'file.create_columns' });
    const created = await run(
      state,
      'create_file',
      {
        format: 'xlsx',
        inputMode: 'pages',
        columns: ['currency', 'amount', 'id'],
        sheetName: 'All',
      },
      { pages },
    );
    if (created.kind !== 'succeeded') throw new Error('Create failed');
    const { file } = created.output as { file: { mediaType: string } };
    expect(file.mediaType).toBe(XLSX);
    const reread = await run(
      state,
      'read_file',
      { format: 'xlsx', sheet: 'All', outputMode: 'pages' },
      { file },
    );
    if (reread.kind !== 'succeeded') throw new Error('Reread failed');
    const bundle = filePageBundleSchema.parse(reread.output);
    expect(bundle).toMatchObject({ itemCount: 2_500, pageCount: 3 });
    const last = bundle.pages.at(-1);
    if (last === undefined) throw new Error('Missing page');
    const page = await run(
      state,
      'read_file',
      { format: 'json' },
      { file: last },
    );
    if (page.kind !== 'succeeded' || !Array.isArray(page.output))
      throw new Error('Page read failed');
    expect(page.output.at(-1)).toEqual({
      currency: 'USD',
      amount: 624.75,
      id: 2_499,
    });
  });

  it('reads a workbook created inline within the inline read limits', async () => {
    const { bytes } = await create({}, orders);
    expect(await readWorkbook(bytes)).toMatchObject({ kind: 'succeeded' });
  });
});
