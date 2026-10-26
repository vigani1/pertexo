import { createHash } from 'node:crypto';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { vi } from 'vitest';
import type { NodeExecutionRuntime } from '@pertexo/node-sdk/server';
import { createCoreNodeRegistry } from '../../../src/server.js';

export type ZipEntry = Readonly<{
  name: string;
  data: string | Uint8Array;
  /** Store instead of deflate. */
  stored?: boolean;
  /** Overrides the uncompressed size the directory declares. */
  declaredSize?: number;
  /** Overrides the compressed payload, for hostile or damaged entries. */
  payload?: Uint8Array;
  flags?: number;
}>;

/** A plain zip writer for fixtures; the reader under test never sees its code. */
export function zip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.from(entry.data);
    const payload = Buffer.from(
      entry.payload ?? (entry.stored === true ? data : deflateRawSync(data)),
    );
    const name = Buffer.from(entry.name);
    const fields = (header: Buffer, at: number) => {
      header.writeUInt16LE(20, at);
      header.writeUInt16LE(entry.flags ?? 0, at + 2);
      header.writeUInt16LE(entry.stored === true ? 0 : 8, at + 4);
      header.writeUInt32LE(0x21_0000, at + 6);
      header.writeUInt32LE(crc32(data), at + 10);
      header.writeUInt32LE(payload.length, at + 14);
      header.writeUInt32LE(entry.declaredSize ?? data.length, at + 18);
      header.writeUInt16LE(name.length, at + 22);
    };
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    fields(local, 4);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    fields(central, 6);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, payload);
    directory.push(central, name);
    offset += local.length + name.length + payload.length;
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

/** Splits a fixture workbook back into entries, to rebuild it with changes. */
export function entriesOf(bytes: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  const end = bytes.length - 22;
  let offset = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < bytes.readUInt16LE(end + 10); index++) {
    const nameLength = bytes.readUInt16LE(offset + 28);
    const local = bytes.readUInt32LE(offset + 42);
    const start = local + 30 + bytes.readUInt16LE(local + 26);
    entries.push({
      name: bytes.subarray(offset + 46, offset + 46 + nameLength).toString(),
      data: inflateRawSync(
        bytes.subarray(start, start + bytes.readUInt32LE(offset + 20)),
      ),
    });
    offset += 46 + nameLength;
  }
  return entries;
}

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RELATIONSHIPS =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE = 'http://schemas.openxmlformats.org/package/2006/relationships';

export type FixtureSheet = Readonly<{
  name: string;
  /** The `<sheetData>` content, or a whole worksheet part with `part`. */
  rows?: string;
  part?: string;
  state?: 'hidden' | 'veryHidden';
  /** Elements after `sheetData`, such as `<mergeCells>`. */
  after?: string;
}>;
export type FixtureWorkbook = Readonly<{
  sheets: readonly FixtureSheet[];
  sharedStrings?: readonly string[];
  /** Raw `<si>` items, for rich text. */
  sharedItems?: string;
  /** Number formats and cell formats; index 0 is the default style. */
  numberFormats?: readonly Readonly<{ id: number; code: string }>[];
  cellFormats?: readonly number[];
  date1904?: boolean;
  workbookContentType?: string;
  extraEntries?: readonly ZipEntry[];
}>;

/** Builds a workbook laid out the way Excel saves one. */
export function workbook(input: FixtureWorkbook): Buffer {
  const sheetEntries = input.sheets.map((sheet, index) => ({
    name: `xl/worksheets/sheet${String(index + 1)}.xml`,
    data:
      sheet.part ??
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<worksheet xmlns="${MAIN}" xmlns:r="${RELATIONSHIPS}"><dimension ref="A1"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetData>${sheet.rows ?? ''}</sheetData>${sheet.after ?? ''}</worksheet>`,
  }));
  const shared =
    input.sharedItems ??
    (input.sharedStrings ?? [])
      .map((text) => `<si><t xml:space="preserve">${escape(text)}</t></si>`)
      .join('');
  return zip([
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${input.workbookContentType ?? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'}"/>${sheetEntries.map((entry) => `<Override PartName="/${entry.name}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PACKAGE}"><Relationship Id="rId1" Type="${RELATIONSHIPS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${MAIN}" xmlns:r="${RELATIONSHIPS}"><workbookPr${input.date1904 === true ? ' date1904="1"' : ''} defaultThemeVersion="166925"/><sheets>${input.sheets.map((sheet, index) => `<sheet name="${escape(sheet.name)}" sheetId="${String(index + 1)}"${sheet.state === undefined ? '' : ` state="${sheet.state}"`} r:id="rId${String(index + 3)}"/>`).join('')}</sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PACKAGE}"><Relationship Id="rId1" Type="${RELATIONSHIPS}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${RELATIONSHIPS}/sharedStrings" Target="sharedStrings.xml"/>${input.sheets.map((_, index) => `<Relationship Id="rId${String(index + 3)}" Type="${RELATIONSHIPS}/worksheet" Target="worksheets/sheet${String(index + 1)}.xml"/>`).join('')}</Relationships>`,
    },
    {
      name: 'xl/styles.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${MAIN}"><numFmts count="${String(input.numberFormats?.length ?? 0)}">${(input.numberFormats ?? []).map((format) => `<numFmt numFmtId="${String(format.id)}" formatCode="${escape(format.code)}"/>`).join('')}</numFmts><cellStyleXfs count="1"><xf numFmtId="14"/></cellStyleXfs><cellXfs count="1">${[0, ...(input.cellFormats ?? [])].map((id) => `<xf numFmtId="${String(id)}" fontId="0" fillId="0" borderId="0" xfId="0"${id === 0 ? '' : ' applyNumberFormat="1"'}/>`).join('')}</cellXfs></styleSheet>`,
    },
    {
      name: 'xl/sharedStrings.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="${MAIN}">${shared}</sst>`,
    },
    ...sheetEntries,
    ...(input.extraEntries ?? []),
  ]);
}

export function escape(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** One `<row>` of shared-string, number or raw cells, the way Excel writes them. */
export function row(index: number, cells: string): string {
  return `<row r="${String(index)}" spans="1:3">${cells}</row>`;
}
export const text = (reference: string, index: number) =>
  `<c r="${reference}" t="s"><v>${String(index)}</v></c>`;
export const number = (reference: string, value: number | string, style = 0) =>
  `<c r="${reference}"${style === 0 ? '' : ` s="${String(style)}"`}><v>${String(value)}</v></c>`;

const identity = { key: 'core.read_file', version: 1 };
const registry = createCoreNodeRegistry();

/** Runs Read file on a workbook the way the worker does for inline output. */
export async function readWorkbook(
  bytes: Uint8Array,
  config: Record<string, unknown> = {},
) {
  const file = {
    kind: 'artifact',
    artifactId: '11111111-1111-4111-8111-111111111111',
    byteLength: bytes.length,
    mediaType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const runtime: NodeExecutionRuntime = {
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
  return registry.execute({
    definition: identity,
    executor: identity,
    config: { format: 'xlsx', ...config },
    input: { file },
    signal: new AbortController().signal,
    runtime,
  });
}
