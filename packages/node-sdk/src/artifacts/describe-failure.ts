import type { FileInputDiagnostic } from './diagnostic.js';
import { describeSheetList } from './sheet-names.js';

const split = 'Split the file into smaller files and run them separately.';

/** Only closed reasons and numeric locations reach stored attempt summaries. */
// eslint-disable-next-line complexity -- Keep the exhaustive diagnostic-to-copy table together; splitting it obscures missing cases.
export function describeFileInputFailure(
  diagnostic: FileInputDiagnostic,
): string {
  switch (diagnostic.reason) {
    case 'multipart_size':
      return 'The multipart request exceeds 10 MB including form headers. A full 10 MB file cannot fit. Use a smaller file or split it into separate uploads accepted by the destination.';
    case 'multipart_values':
      return 'Multipart inputs do not match the parts. Give each text part a text value and each file part a file reference; remove unused inputs or the raw body.';
    case 'multipart_content_type':
      return 'Multipart generates its own Content-Type and boundary. Remove Content-Type from the step headers or its connection before running again.';
    case 'multipart_encoding':
      return 'The multipart request could not be assembled. Start a new run; no request was sent.';
    case 'multipart_boundary':
      return 'A multipart boundary could not be generated safely. Start a new run.';
    case 'file_size':
      return `The file exceeds this operation's file limit (up to 10 MB, or the lower configured storage limit). ${split}`;
    case 'inline_file_size':
      return `Inline Read file accepts up to 1 MB. For CSV, Excel or a JSON list, choose Output pages (up to 10 MB); otherwise split the file.`;
    case 'page_array':
      return 'Output pages needs a top-level JSON list. Choose Inline data for a small object, or export a list.';
    case 'page_value_size':
      return `One record exceeds a data page (64 KB, depth 48 or 4,000 fields/items). Narrow or flatten the record. ${split}`;
    case 'page_item_count':
      return `The file contains more than 100,000 records. ${split}`;
    case 'value_size':
      return `The parsed file exceeds the step's value limits. Wide rows fit fewer records. ${split}`;
    case 'item_count':
      return `The file contains too many items. About 4,996 narrow rows fit an end-to-end list workflow. ${split}`;
    case 'invalid_utf8':
      return 'The file is not valid UTF-8. Export it as UTF-8 and upload the corrected file.';
    case 'json_number':
      return 'The JSON contains a number outside the supported finite range. Correct it and upload the file again.';
    case 'json_syntax':
      return `The JSON is malformed${diagnostic.position === undefined ? '' : ` near position ${String(diagnostic.position)}`}. Correct it and upload the file again.`;
    case 'csv_empty':
      return 'The CSV has no header row. Add column names and upload the corrected file.';
    case 'csv_syntax':
      return `The CSV quoting is malformed${diagnostic.line === undefined ? '' : ` near line ${String(diagnostic.line)}`}. Check the delimiter and quotes, then upload the corrected file.`;
    case 'blank_header':
      return `Header column ${String(diagnostic.column)} is blank. Give every column a name and upload the corrected file.`;
    case 'duplicate_header':
      return diagnostic.merged === true
        ? `Header column ${String(diagnostic.column)} repeats a column name because it is part of a merged area, and every cell of a merged area reads its top-left value. A title merged across the columns is the usual cause: set Header row to the row that holds the column names.`
        : `Header column ${String(diagnostic.column)} repeats a column name. Use unique names and upload the corrected file.`;
    case 'csv_columns':
      return `CSV record ${String(diagnostic.record)} has ${String(diagnostic.actual)} ${diagnostic.actual === 1 ? 'column' : 'columns'}; the header has ${String(diagnostic.expected)}. Check the delimiter and quoting, then upload the corrected file.`;
    case 'spreadsheet_too_large':
      return 'The workbook is too large to read safely. Read file opens workbooks up to 100 MB uncompressed, with at most 1,000 internal parts and 256 sheets, and reads up to 1,000,000 cells per step. Delete unused sheets, or split the rows into smaller workbooks and run them separately.';
    case 'unsupported_spreadsheet':
      return 'The file is not a readable Excel workbook (.xlsx). Legacy .xls, macro-enabled .xlsm, password-protected and damaged files cannot be read. Open it in Excel, save it as Excel Workbook (.xlsx) and upload it again.';
    case 'sheet_missing':
      return `The workbook has no sheet with that name. ${describeSheetList(diagnostic)} Enter a name exactly, or leave Sheet empty to read the first visible sheet.`;
    case 'sheet_header_row':
      return `Row ${String(diagnostic.row)} of the sheet is empty, so there are no column names. Set Header row to the row that holds the column names.`;
    case 'file_unavailable':
      return 'The file is unavailable in this workspace. Upload it again and use the new file reference.';
    case 'file_integrity':
      return 'The file no longer matches its saved reference. Upload it again and use the new file reference.';
  }
}
