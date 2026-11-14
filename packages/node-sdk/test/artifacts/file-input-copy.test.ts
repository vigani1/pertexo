import { describe, expect, it } from 'vitest';
import { FileInputFailure } from '../../src/artifacts/file-input.errors.js';

const summary = (
  diagnostic: ConstructorParameters<typeof FileInputFailure>[0],
) => new FileInputFailure(diagnostic).errorSummary;

describe('file input failure text', () => {
  it('states the file sizes the steps enforce', () => {
    expect(summary({ reason: 'multipart_size' })).toContain(
      'The multipart request exceeds 10 MB including form headers. A full 10 MB file cannot fit.',
    );
    expect(summary({ reason: 'inline_file_size' })).toContain(
      'Inline Read file accepts up to 1 MB. For CSV, Excel or a JSON list, choose Output pages (up to 10 MB)',
    );
    expect(summary({ reason: 'page_value_size' })).toContain(
      'One record exceeds a data page (64 KB, depth 48 or 4,000 fields/items).',
    );
    expect(summary({ reason: 'page_item_count' })).toContain(
      'The file contains more than 100,000 records.',
    );
  });

  it('states the workbook bounds the reader refused with', () => {
    expect(
      summary({
        reason: 'spreadsheet_too_large',
        limits: {
          uncompressedBytes: 104_857_600,
          entries: 1_000,
          sheets: 256,
          cells: 1_000_000,
        },
      }),
    ).toContain(
      'Read file opens workbooks up to 100 MB uncompressed, with at most 1,000 internal parts and 256 sheets, and reads up to 1,000,000 cells per step.',
    );
  });
});
