import { describe, expect, it } from 'vitest';
import {
  number,
  readWorkbook,
  row,
  text,
  workbook,
} from './workbook.fixture.js';

async function rows(bytes: Uint8Array, config?: Record<string, unknown>) {
  const result = await readWorkbook(bytes, config);
  if (result.kind !== 'succeeded') throw new Error('Read failed');
  return result.output;
}

const orders = workbook({
  sharedStrings: ['name', 'amount', 'paid', 'Ada', 'Grace'],
  sheets: [
    {
      name: 'Orders',
      rows:
        row(1, text('A1', 0) + text('B1', 1) + text('C1', 2)) +
        row(
          2,
          text('A2', 3) + number('B2', 12.5) + '<c r="C2" t="b"><v>1</v></c>',
        ) +
        row(
          3,
          text('A3', 4) + number('B3', -2) + '<c r="C3" t="b"><v>0</v></c>',
        ),
    },
  ],
});

describe('Read file with Excel workbooks', () => {
  it('reads rows keyed by the header, keeping number and boolean cells typed', async () => {
    expect(await rows(orders)).toEqual([
      { name: 'Ada', amount: 12.5, paid: true },
      { name: 'Grace', amount: -2, paid: false },
    ]);
  });

  it('gives every cell as text, the way Excel exports CSV, when conversion is off', async () => {
    expect(await rows(orders, { convertValues: false })).toEqual([
      { name: 'Ada', amount: '12.5', paid: 'TRUE' },
      { name: 'Grace', amount: '-2', paid: 'FALSE' },
    ]);
  });

  it('uses cached formula values, inline and rich text, errors and escaped characters', async () => {
    const bytes = workbook({
      sharedItems:
        '<si><t>label</t></si><si><r><rPr><b/></rPr><t>Bold </t></r><r><t>and plain</t></r><rPh sb="0" eb="1"><t>ふりがな</t></rPh></si><si><t>line_x000D_break</t></si>',
      sheets: [
        {
          name: 'Sheet1',
          rows:
            row(
              1,
              text('A1', 0) +
                '<c r="B1" t="inlineStr"><is><t>total</t></is></c>',
            ) +
            row(2, text('A2', 1) + '<c r="B2"><f>SUM(C2:D2)</f><v>42</v></c>') +
            row(
              3,
              text('A3', 2) +
                '<c r="B3" t="str"><f>A1&amp;"!"</f><v>label!</v></c>',
            ) +
            row(
              4,
              '<c r="A4" t="e"><f>1/0</f><v>#DIV/0!</v></c><c r="B4"><f>NOW()</f></c>',
            ),
        },
      ],
    });
    expect(await rows(bytes)).toEqual([
      { label: 'Bold and plain', total: 42 },
      { label: 'line\rbreak', total: 'label!' },
      { label: '#DIV/0!', total: '' },
    ]);
  });

  it('keeps leading-zero text and integers beyond the safe range as written', async () => {
    const bytes = workbook({
      sharedStrings: ['id', 'big', '00123'],
      sheets: [
        {
          name: 'Sheet1',
          rows:
            row(1, text('A1', 0) + text('B1', 1)) +
            row(2, text('A2', 2) + number('B2', '9.2233720368547758E+18')),
        },
      ],
    });
    expect(await rows(bytes)).toEqual([
      { id: '00123', big: '9.2233720368547758E+18' },
    ]);
  });

  it('turns date, time and date-time formats into ISO text and leaves elapsed time as numbers', async () => {
    const bytes = workbook({
      sharedStrings: ['date', 'time', 'stamp', 'custom', 'elapsed', 'early'],
      numberFormats: [
        { id: 164, code: 'yyyy\\-mm\\-dd\\ hh:mm' },
        { id: 165, code: '[h]:mm' },
        { id: 166, code: '[$-409]d-mmm-yy;@' },
      ],
      cellFormats: [14, 18, 22, 164, 165, 166],
      sheets: [
        {
          name: 'Sheet1',
          rows:
            row(
              1,
              ['A', 'B', 'C', 'D', 'E', 'F']
                .map((column, index) => text(`${column}1`, index))
                .join(''),
            ) +
            row(
              2,
              number('A2', 46314, 1) +
                number('B2', 0.395833333333333, 2) +
                number('C2', 46314.75, 3) +
                number('D2', 46314.5, 4) +
                number('E2', 1.5, 5) +
                number('F2', 59, 6),
            ),
        },
      ],
    });
    expect(await rows(bytes)).toEqual([
      {
        date: '2026-10-19',
        time: '09:30:00',
        stamp: '2026-10-19T18:00:00.000Z',
        custom: '2026-10-19T12:00:00.000Z',
        elapsed: 1.5,
        early: '1900-02-28',
      },
    ]);
  });

  it('counts dates from 1904 when the workbook uses that system', async () => {
    const bytes = workbook({
      date1904: true,
      sharedStrings: ['day'],
      cellFormats: [14],
      sheets: [
        {
          name: 'Sheet1',
          rows: row(1, text('A1', 0)) + row(2, number('A2', 44852, 1)),
        },
      ],
    });
    expect(await rows(bytes)).toEqual([{ day: '2026-10-19' }]);
  });

  it('reads every position of a merged area as its top-left value', async () => {
    const bytes = workbook({
      sharedStrings: [
        'region',
        'city',
        'sales',
        'North',
        'Oslo',
        'Bergen',
        'Tromsø',
        'note',
      ],
      sheets: [
        {
          name: 'Sheet1',
          rows:
            row(1, text('A1', 0) + text('B1', 1) + text('C1', 2)) +
            row(2, text('A2', 3) + text('B2', 4) + number('C2', 10)) +
            row(3, '<c r="A3" s="0"/>' + text('B3', 5) + number('C3', 20)) +
            row(4, text('B4', 6) + number('C4', 5)) +
            // A row that only continues a merge holds no data of its own.
            row(5, '<c r="A5"/>') +
            row(6, text('A6', 7)),
          after:
            '<mergeCells count="2"><mergeCell ref="A2:A5"/><mergeCell ref="A6:C6"/></mergeCells>',
        },
      ],
    });
    expect(await rows(bytes)).toEqual([
      { region: 'North', city: 'Oslo', sales: 10 },
      { region: 'North', city: 'Bergen', sales: 20 },
      { region: 'North', city: 'Tromsø', sales: 5 },
      { region: 'note', city: 'note', sales: 'note' },
    ]);
  });

  it('reads the first visible sheet by default and any sheet by name, ignoring case', async () => {
    const bytes = workbook({
      sharedStrings: ['sheet', 'hidden', 'first', 'second'],
      sheets: [
        {
          name: 'Lookup',
          state: 'hidden',
          rows: row(1, text('A1', 0)) + row(2, text('A2', 1)),
        },
        { name: 'Q1', rows: row(1, text('A1', 0)) + row(2, text('A2', 2)) },
        {
          name: 'Q2 2026',
          rows: row(1, text('A1', 0)) + row(2, text('A2', 3)),
        },
      ],
    });
    expect(await rows(bytes)).toEqual([{ sheet: 'first' }]);
    expect(await rows(bytes, { sheet: 'q2 2026' })).toEqual([
      { sheet: 'second' },
    ]);
    expect(await rows(bytes, { sheet: 'Lookup' })).toEqual([
      { sheet: 'hidden' },
    ]);
  });

  it('names the workbook sheets when the chosen one does not exist', async () => {
    await expect(
      readWorkbook(orders, { sheet: 'Sales' }),
    ).rejects.toMatchObject({
      safeErrorCode: 'execution.file_input',
      diagnostic: { reason: 'sheet_missing', sheets: ['Orders'], more: 0 },
      errorSummary: expect.stringContaining('Its sheets: "Orders".') as unknown,
    });
  });

  it('starts at a later header row, skipping titles, empty rows and trailing columns', async () => {
    const bytes = workbook({
      sharedStrings: ['Quarterly report', 'sku', 'qty', 'A-1', 'B-2'],
      sheets: [
        {
          name: 'Sheet1',
          rows:
            row(1, text('A1', 0)) +
            row(3, text('A3', 1) + text('B3', 2) + '<c r="C3" s="1"/>') +
            row(4, text('A4', 3) + number('B4', 4) + '<c r="F4" s="1"/>') +
            row(6, '<c r="A6" s="1"/>') +
            row(7, text('A7', 4) + number('B7', 1)) +
            row(9, '<c r="A9" s="1"/><c r="B9" s="1"/>'),
        },
      ],
    });
    expect(await rows(bytes, { headerRow: 3 })).toEqual([
      { sku: 'A-1', qty: 4 },
      { sku: 'B-2', qty: 1 },
    ]);
  });

  it.each([
    ['an empty sheet', '', 1, { reason: 'sheet_header_row', row: 1 }],
    [
      'a header row past the data',
      row(1, text('A1', 0)),
      4,
      { reason: 'sheet_header_row', row: 4 },
    ],
    [
      'a blank header between names',
      row(1, text('A1', 0) + text('C1', 1)),
      1,
      { reason: 'blank_header', column: 2 },
    ],
    [
      'a repeated header',
      row(1, text('A1', 0) + text('B1', 0)),
      1,
      { reason: 'duplicate_header', column: 2 },
    ],
    [
      'data under no header',
      row(1, text('A1', 0)) + row(2, text('A2', 1) + text('C2', 1)),
      1,
      { reason: 'blank_header', column: 3 },
    ],
  ])(
    'rejects %s with its position',
    async (_, sheetRows, headerRow, diagnostic) => {
      const bytes = workbook({
        sharedStrings: ['a', 'b'],
        sheets: [{ name: 'Sheet1', rows: sheetRows }],
      });
      await expect(readWorkbook(bytes, { headerRow })).rejects.toMatchObject({
        diagnostic,
      });
    },
  );

  it('accepts a header-only sheet and namespace-prefixed parts', async () => {
    const prefixed = workbook({
      sharedStrings: ['only'],
      sheets: [
        {
          name: 'Sheet1',
          part: '<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData><x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c></x:row></x:sheetData></x:worksheet>',
        },
      ],
    });
    expect(await rows(prefixed)).toEqual([]);
  });
});
