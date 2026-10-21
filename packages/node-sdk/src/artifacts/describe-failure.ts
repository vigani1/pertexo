import type { FileInputDiagnostic } from './diagnostic.js';

const split = 'Split the file into smaller files and run them separately.';

/** Only closed reasons and numeric locations reach stored attempt summaries. */
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
      return `The file exceeds this operation's limit: 1 MB for inline Read file, or up to 10 MB for file transfers (less when storage is configured lower). ${split}`;
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
    case 'csv_blank_header':
      return `CSV header column ${String(diagnostic.column)} is blank. Give every column a name and upload the corrected file.`;
    case 'csv_duplicate_header':
      return `CSV header column ${String(diagnostic.column)} repeats a column name. Use unique names and upload the corrected file.`;
    case 'csv_columns':
      return `CSV record ${String(diagnostic.record)} has ${String(diagnostic.actual)} ${diagnostic.actual === 1 ? 'column' : 'columns'}; the header has ${String(diagnostic.expected)}. Check the delimiter and quoting, then upload the corrected file.`;
    case 'file_unavailable':
      return 'The file is unavailable in this workspace. Upload it again and use the new file reference.';
    case 'file_integrity':
      return 'The file no longer matches its saved reference. Upload it again and use the new file reference.';
  }
}
