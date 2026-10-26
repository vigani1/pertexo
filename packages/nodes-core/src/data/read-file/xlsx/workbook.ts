import { FileInputFailure, listSheetNames } from '@pertexo/node-sdk/server';
import {
  openWorkbookArchive,
  tooLarge,
  unsupported,
  type WorkbookArchive,
} from './archive.js';
import { SPREADSHEET_LIMITS } from './limits.js';
import { readXml } from './xml.js';

type WorkbookSheet = Readonly<{ name: string; visible: boolean; part: string }>;
export type Workbook = Readonly<{
  archive: WorkbookArchive;
  /** Worksheets in workbook order; chart and dialog sheets hold no rows. */
  sheets: readonly WorkbookSheet[];
  date1904: boolean;
  sharedStringsPart?: string;
  stylesPart?: string;
}>;
type Relationship = Readonly<{ type: string; part: string }>;

const WORKBOOK_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml',
]);
// Macro-enabled workbooks, VBA projects and Excel 4 macro sheets.
const MACRO_CONTENT = /macroEnabled|vbaProject|macrosheet/iu;

/** Opens the workbook structure; external links and embedded objects are never read. */
export async function openWorkbook(
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<Workbook> {
  const archive = openWorkbookArchive(bytes);
  for (const name of archive.names())
    if (/(?:^|\/)vbaProject\.bin$/iu.test(name)) unsupported();
  const contentTypes = await readContentTypes(archive, signal);
  const document = [
    ...(await readRelationships(archive, '', signal)).values(),
  ].find((relationship) => relationship.type === 'officeDocument');
  if (
    document === undefined ||
    !WORKBOOK_TYPES.has(contentTypes.get(document.part) ?? '')
  )
    unsupported();
  const byId = await readRelationships(archive, document.part, signal);
  const contents = await readWorkbookPart(archive, document.part, signal);
  const sheets = contents.sheets.flatMap((sheet) => {
    const target = byId.get(sheet.id);
    return target?.type === 'worksheet'
      ? [{ name: sheet.name, visible: sheet.visible, part: target.part }]
      : [];
  });
  const part = (type: string) =>
    [...byId.values()].find(
      (relationship) =>
        relationship.type === type && archive.has(relationship.part),
    )?.part;
  const sharedStringsPart = part('sharedStrings');
  const stylesPart = part('styles');
  return Object.freeze({
    archive,
    sheets,
    date1904: contents.date1904,
    ...(sharedStringsPart === undefined ? {} : { sharedStringsPart }),
    ...(stylesPart === undefined ? {} : { stylesPart }),
  });
}

/** Sheet names compare as Excel does, ignoring case; empty means the first visible. */
export function chooseSheet(
  workbook: Workbook,
  name: string | undefined,
): WorkbookSheet {
  const wanted = name?.toLowerCase();
  const sheet =
    wanted === undefined
      ? (workbook.sheets.find((candidate) => candidate.visible) ??
        workbook.sheets[0])
      : workbook.sheets.find(
          (candidate) => candidate.name.toLowerCase() === wanted,
        );
  if (sheet === undefined || !workbook.archive.has(sheet.part))
    throw new FileInputFailure({
      reason: 'sheet_missing',
      ...listSheetNames(workbook.sheets.map((candidate) => candidate.name)),
    });
  return sheet;
}

async function readContentTypes(
  archive: WorkbookArchive,
  signal: AbortSignal,
): Promise<ReadonlyMap<string, string>> {
  if (!archive.has('[Content_Types].xml')) unsupported();
  const overrides = new Map<string, string>();
  await readXml(
    archive.read('[Content_Types].xml', signal),
    {
      open: (name, attributes) => {
        const type = attributes.ContentType ?? '';
        if (MACRO_CONTENT.test(type)) unsupported();
        if (name === 'Override' && attributes.PartName !== undefined)
          overrides.set(resolvePart('', attributes.PartName), type);
      },
    },
    signal,
  );
  return overrides;
}

/** Relationship types are compared by their last segment, as transitional and strict URIs differ. */
async function readRelationships(
  archive: WorkbookArchive,
  source: string,
  signal: AbortSignal,
): Promise<ReadonlyMap<string, Relationship>> {
  const slash = source.lastIndexOf('/');
  const name = `${source.slice(0, slash + 1)}_rels/${source.slice(slash + 1)}.rels`;
  const relationships = new Map<string, Relationship>();
  if (!archive.has(name)) return relationships;
  await readXml(
    archive.read(name, signal),
    {
      open: (element, attributes) => {
        const { Id: id, Type: type, Target: target } = attributes;
        if (
          element !== 'Relationship' ||
          id === undefined ||
          type === undefined ||
          target === undefined ||
          attributes.TargetMode === 'External'
        )
          return;
        if (relationships.size >= SPREADSHEET_LIMITS.entries) tooLarge();
        relationships.set(id, {
          type: type.slice(type.lastIndexOf('/') + 1),
          part: resolvePart(source, target),
        });
      },
    },
    signal,
  );
  return relationships;
}

async function readWorkbookPart(
  archive: WorkbookArchive,
  part: string,
  signal: AbortSignal,
) {
  const sheets: { name: string; visible: boolean; id: string }[] = [];
  let date1904 = false;
  await readXml(
    archive.read(part, signal),
    {
      open: (name, attributes) => {
        if (name === 'workbookPr')
          date1904 =
            attributes.date1904 === '1' || attributes.date1904 === 'true';
        if (name !== 'sheet') return;
        if (sheets.length >= SPREADSHEET_LIMITS.sheets) tooLarge();
        if (attributes.name !== undefined && attributes.id !== undefined)
          sheets.push({
            name: attributes.name,
            visible: (attributes.state ?? 'visible') === 'visible',
            id: attributes.id,
          });
      },
    },
    signal,
  );
  return { sheets, date1904 };
}

/** Relationship targets are relative to their source part unless rooted. */
function resolvePart(source: string, target: string): string {
  let decoded = target;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    // An undecodable target is used as written.
  }
  const segments = decoded.startsWith('/')
    ? []
    : source.split('/').slice(0, -1);
  for (const segment of decoded.split('/')) {
    if (segment === '..') segments.pop();
    else if (segment !== '' && segment !== '.') segments.push(segment);
  }
  return segments.join('/');
}
