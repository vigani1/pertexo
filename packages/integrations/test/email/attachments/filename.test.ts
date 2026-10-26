import { describe, expect, it } from 'vitest';
import { utf8ByteLength } from '@pertexo/workflow-model';
import {
  defaultAttachmentFilename,
  sanitizeAttachmentFilename,
} from '../../../src/index.js';

describe('email attachment filenames', () => {
  it('names an unnamed file after its stored media type', () => {
    expect(
      defaultAttachmentFilename('text/csv; charset=utf-8', {
        index: 0,
        count: 1,
      }),
    ).toBe('attachment.csv');
    expect(
      defaultAttachmentFilename('application/pdf', { index: 1, count: 3 }),
    ).toBe('attachment-2.pdf');
    expect(
      defaultAttachmentFilename('application/x-unknown', {
        index: 0,
        count: 1,
      }),
    ).toBe('attachment');
  });

  it('drops path separators and control characters and keeps the rest', () => {
    expect(sanitizeAttachmentFilename('../reports/weekly\\report.csv')).toBe(
      '..reportsweeklyreport.csv',
    );
    expect(sanitizeAttachmentFilename('week\u0000ly\r\n report.csv')).toBe(
      'weekly report.csv',
    );
    expect(sanitizeAttachmentFilename('  Résumé – 2026.pdf  ')).toBe(
      'Résumé – 2026.pdf',
    );
  });

  it('drops format characters, such as bidi overrides, from a name', () => {
    expect(sanitizeAttachmentFilename('report\u202Efdp.txt')).toBe(
      'reportfdp.txt',
    );
    expect(sanitizeAttachmentFilename('\u202E\u200B')).toBeUndefined();
  });

  it('leaves nothing usable as no name, so the default applies', () => {
    for (const value of ['', '   ', '///', '\u0007', '.', '..'])
      expect(sanitizeAttachmentFilename(value)).toBeUndefined();
  });

  it('caps a long name at 255 UTF-8 bytes and keeps its extension', () => {
    const name = sanitizeAttachmentFilename(`${'é'.repeat(300)}.xlsx`);
    expect(name).toMatch(/^é+\.xlsx$/u);
    expect(utf8ByteLength(name ?? '')).toBeLessThanOrEqual(255);
    expect(utf8ByteLength(name ?? '')).toBeGreaterThan(250);
    expect(sanitizeAttachmentFilename('a'.repeat(400))).toBe('a'.repeat(255));
  });
});
