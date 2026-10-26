import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { expect, type Page } from '@playwright/test';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import { csrfHeaders } from '../../test/support/browser/csrf';
import { test } from '../support/browser-fixture';
import { createOwnedHttpConnection } from '../support/authoring/http-connection';
import {
  addSingleStep,
  createEditorWorkflow,
  publishSingleStep,
  readEditorDraft,
  startSingleStep,
  waitForRun,
} from '../support/authoring/single-step';

type Cell = string | number | boolean;
const XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

test('reads sheet 2 of an uploaded workbook, filters it and downloads a new workbook', async ({
  page,
  request,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { workspaceId } = await createOwnedHttpConnection(page, request);
  const path = await createEditorWorkflow(page, workspaceId, 'Paid Q2 orders');
  const readId = await addSingleStep(page, path, /Read file/u, 'Read Q2 sheet');
  await page.getByRole('button', { name: 'Excel', exact: true }).click();
  await expect
    .poll(
      async () => (await readEditorDraft(page, path)).graph.nodes[0]?.config,
    )
    .toEqual({ format: 'xlsx', headerRow: 1, convertValues: true });
  await upload(
    page,
    workbook([
      {
        name: 'Q1 2026',
        rows: [
          ['city', 'sales', 'paid'],
          ['Tromsø', 5, true],
        ],
      },
      {
        name: 'Q2 2026',
        rows: [
          ['city', 'sales', 'paid'],
          ['Oslo', 1240.5, true],
          ['Bergen', 980, false],
          ['Stavanger', 455, true],
        ],
      },
    ]),
  );
  await page.getByRole('tab', { name: 'Setup', exact: true }).click();
  const sheet = page.getByRole('textbox', { name: 'Sheet', exact: true });
  await sheet.fill('Sales');
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, path)).graph.nodes[0]?.config.sheet,
    )
    .toBe('Sales');

  // The worker names the workbook's sheets; Setup offers them as tabs.
  await runStepTest(page, 'Run test');
  await page.getByRole('tab', { name: 'Setup', exact: true }).click();
  await page
    .getByRole('button', { name: 'Use sheet Q2 2026', exact: true })
    .click();
  await expect(sheet).toHaveValue('Q2 2026');
  await runStepTest(page, 'Run another test');
  await page.getByRole('tab', { name: 'Setup', exact: true }).click();
  const grid = page.getByRole('table', {
    name: 'First rows from the last test',
  });
  await expect(grid.getByRole('columnheader')).toHaveText([
    'city',
    'sales',
    'paid',
  ]);
  await expect(grid.getByRole('cell').first()).toHaveText('Oslo');
  await page.keyboard.press('Escape');

  const response = await page.request.get(`${path}/draft`);
  const { graph } = await readEditorDraft(page, path);
  const nodes = [
    ...graph.nodes,
    step({
      id: 'paid',
      key: 'core.filter',
      x: 320,
      config: { path: '$.paid', operator: 'equals' },
      inputMappings: {
        items: { kind: 'node_output', nodeId: readId, path: '$' },
        value: { kind: 'literal', value: true },
      },
    }),
    step({
      id: 'export',
      key: 'core.create_file',
      x: 640,
      config: {
        format: 'xlsx',
        sheetName: 'Paid orders',
        columns: ['sales', 'city'],
      },
      inputMappings: {
        data: { kind: 'node_output', nodeId: 'paid', path: '$.items' },
      },
    }),
  ];
  expect(
    (
      await page.request.put(`${path}/draft`, {
        headers: {
          ...(await csrfHeaders(page)),
          'If-Match': response.headers().etag ?? '',
        },
        data: {
          graph: {
            ...graph,
            nodes,
            edges: [
              link('read-paid', readId, 'paid'),
              link('paid-export', 'paid', 'export'),
            ],
          },
        },
      })
    ).status(),
  ).toBe(200);
  await page.reload();
  await publishSingleStep(page, path);
  const runId = await startSingleStep(page, {});
  const run = await waitForRun(page, workspaceId, runId, 'succeeded');
  const exported = run.nodes.find((item) => item.nodeId === 'export');
  if (exported === undefined) throw new Error('Create file did not run');
  const output = (await (
    await page.request.get(
      `/v1/workspaces/${workspaceId}/runs/${runId}/node-runs/${exported.id}/output`,
    )
  ).json()) as {
    output: { value: { file: { artifactId: string; mediaType: string } } };
  };
  const { file } = output.output.value;
  expect(file.mediaType).toBe(XLSX);
  const prepared = (await (
    await page.request.get(
      `/v1/workspaces/${workspaceId}/artifacts/${file.artifactId}/download`,
    )
  ).json()) as { url: string };
  const download = await page.request.get(prepared.url);
  expect(download.ok()).toBe(true);
  const parts = unzip(await download.body());
  expect(parts.get('xl/workbook.xml')).toContain('<sheet name="Paid orders"');
  expect(sheetRows(parts.get('xl/worksheets/sheet1.xml') ?? '')).toEqual([
    ['sales', 'city'],
    ['1240.5', 'Oslo'],
    ['455', 'Stavanger'],
  ]);
});

async function upload(page: Page, buffer: Buffer) {
  await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
  await page
    .getByRole('button', { name: 'Upload file to read', exact: true })
    .click();
  await page
    .getByLabel('File', { exact: true })
    .setInputFiles({ name: 'sales.xlsx', mimeType: XLSX, buffer });
  await expect(page.getByText('File ready', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Use file', exact: true }).click();
}

async function runStepTest(page: Page, label: string) {
  await page.getByRole('tab', { name: 'Test', exact: true }).click();
  const acknowledge = page.getByRole('switch', {
    name: 'I understand this test runs for real',
  });
  if (!(await acknowledge.isChecked())) await acknowledge.click();
  await page.getByRole('button', { name: label, exact: true }).click();
  await expect(page.getByRole('region', { name: 'Test result' })).toBeVisible({
    timeout: 30_000,
  });
}

function step({
  id,
  key,
  x,
  config,
  inputMappings,
}: Readonly<{
  id: string;
  key: string;
  x: number;
  config: WorkflowGraphContract['nodes'][number]['config'];
  inputMappings: WorkflowGraphContract['nodes'][number]['inputMappings'];
}>) {
  return {
    id,
    label: id,
    definition: { key, version: 1 },
    configVersion: 1,
    config,
    inputMappings,
    connectionRefs: {},
    position: { x, y: 0 },
  };
}

function link(id: string, source: string, target: string) {
  return {
    id,
    source: { nodeId: source, port: 'out' },
    target: { nodeId: target, port: 'in' },
  };
}

/** A small workbook laid out as Excel saves one, with inline-string cells. */
function workbook(sheets: readonly { name: string; rows: Cell[][] }[]): Buffer {
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const rel =
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const cell = (value: Cell, reference: string) => {
    if (typeof value === 'number')
      return `<c r="${reference}"><v>${String(value)}</v></c>`;
    if (typeof value === 'boolean')
      return `<c r="${reference}" t="b"><v>${value ? '1' : '0'}</v></c>`;
    return `<c r="${reference}" t="inlineStr"><is><t>${value}</t></is></c>`;
  };
  return zip([
    [
      '[Content_Types].xml',
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
    ],
    [
      '_rels/.rels',
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ],
    [
      'xl/workbook.xml',
      `<workbook xmlns="${main}" xmlns:r="${rel}"><sheets>${sheets.map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${String(index + 1)}" r:id="rId${String(index + 1)}"/>`).join('')}</sheets></workbook>`,
    ],
    [
      'xl/_rels/workbook.xml.rels',
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="rId${String(index + 1)}" Type="${rel}/worksheet" Target="worksheets/sheet${String(index + 1)}.xml"/>`).join('')}</Relationships>`,
    ],
    ...sheets.map((sheet, index): [string, string] => [
      `xl/worksheets/sheet${String(index + 1)}.xml`,
      `<worksheet xmlns="${main}"><sheetData>${sheet.rows
        .map(
          (row, rowIndex) =>
            `<row r="${String(rowIndex + 1)}">${row.map((value, column) => cell(value, `${String.fromCharCode(65 + column)}${String(rowIndex + 1)}`)).join('')}</row>`,
        )
        .join('')}</sheetData></worksheet>`,
    ]),
  ]);
}

function zip(entries: readonly [string, string][]): Buffer {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const data = Buffer.from(text);
    const packed = deflateRawSync(data);
    const fileName = Buffer.from(name);
    const header = (size: number, start: number) => {
      const buffer = Buffer.alloc(size);
      buffer.writeUInt16LE(20, start);
      buffer.writeUInt16LE(8, start + 4);
      buffer.writeUInt32LE(crc32(data), start + 10);
      buffer.writeUInt32LE(packed.length, start + 14);
      buffer.writeUInt32LE(data.length, start + 18);
      buffer.writeUInt16LE(fileName.length, start + 22);
      return buffer;
    };
    const local = header(30, 4);
    local.writeUInt32LE(0x04034b50, 0);
    const central = header(46, 6);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(offset, 42);
    locals.push(local, fileName, packed);
    directory.push(central, fileName);
    offset += local.length + fileName.length + packed.length;
  }
  const centralBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

/** Reads a downloaded zip's parts, following its central directory. */
function unzip(bytes: Buffer): ReadonlyMap<string, string> {
  const parts = new Map<string, string>();
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let offset = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < bytes.readUInt16LE(end + 10); index++) {
    const nameLength = bytes.readUInt16LE(offset + 28);
    const local = bytes.readUInt32LE(offset + 42);
    const start =
      local +
      30 +
      bytes.readUInt16LE(local + 26) +
      bytes.readUInt16LE(local + 28);
    const packed = bytes.subarray(
      start,
      start + bytes.readUInt32LE(offset + 20),
    );
    parts.set(
      bytes.subarray(offset + 46, offset + 46 + nameLength).toString(),
      inflateRawSync(packed).toString(),
    );
    offset +=
      46 +
      nameLength +
      bytes.readUInt16LE(offset + 30) +
      bytes.readUInt16LE(offset + 32);
  }
  return parts;
}

function sheetRows(xml: string): string[][] {
  return [...xml.matchAll(/<row[^>]*>(.*?)<\/row>/gu)].map((row) =>
    [...(row[1] ?? '').matchAll(/<(?:v|t[^>]*)>([^<]*)<\/(?:v|t)>/gu)].map(
      (match) => match[1] ?? '',
    ),
  );
}
