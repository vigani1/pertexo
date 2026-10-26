import { escapeXml, sheetXml, type SheetRow } from './sheet.js';
import { writeZip } from './zip.js';

export const XLSX_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const DECLARATION =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RELATIONSHIPS =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE = 'http://schemas.openxmlformats.org/package/2006/relationships';
const TYPES = 'application/vnd.openxmlformats-officedocument.spreadsheetml';

// Fonts: regular and bold. Cell formats: plain, bold header, quoted text and
// a quoted header; sheet.ts adds the indexes up.
const STYLES = `${DECLARATION}<styleSheet xmlns="${MAIN}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" quotePrefix="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" quotePrefix="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/** One sheet named by the step; the rows stream straight into the archive. */
export function writeWorkbook(
  input: Readonly<{
    sheetName: string;
    columns: readonly string[];
    rows: AsyncIterable<SheetRow> | Iterable<SheetRow>;
  }>,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const part = (xml: string) => Buffer.from(DECLARATION + xml, 'utf8');
  return writeZip(
    [
      {
        name: '[Content_Types].xml',
        content: part(
          `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${TYPES}.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="${TYPES}.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="${TYPES}.styles+xml"/></Types>`,
        ),
      },
      {
        name: '_rels/.rels',
        content: part(
          `<Relationships xmlns="${PACKAGE}"><Relationship Id="rId1" Type="${RELATIONSHIPS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
        ),
      },
      {
        name: 'xl/workbook.xml',
        content: part(
          `<workbook xmlns="${MAIN}" xmlns:r="${RELATIONSHIPS}"><bookViews><workbookView/></bookViews><sheets><sheet name="${escapeXml(input.sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        ),
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        content: part(
          `<Relationships xmlns="${PACKAGE}"><Relationship Id="rId1" Type="${RELATIONSHIPS}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${RELATIONSHIPS}/styles" Target="styles.xml"/></Relationships>`,
        ),
      },
      { name: 'xl/styles.xml', content: Buffer.from(STYLES, 'utf8') },
      {
        name: 'xl/worksheets/sheet1.xml',
        content: sheetXml(input.columns, input.rows, signal),
      },
    ],
    signal,
  );
}
