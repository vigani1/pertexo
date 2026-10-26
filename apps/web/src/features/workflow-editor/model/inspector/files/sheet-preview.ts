import type { PreviewRunSummary } from '@pertexo/contracts';
import { filePageBundleSchema, readSheetSuggestions } from '@pertexo/node-sdk';

/** Rows and columns the small grid shows; the rest scroll or stay counted. */
export const SHEET_PREVIEW_ROWS = 4;
const PREVIEW_COLUMNS = 12;

export type SheetPreview =
  | Readonly<{ kind: 'untested' }>
  | Readonly<{ kind: 'testing' }>
  | Readonly<{
      kind: 'rows';
      headers: readonly string[];
      rows: readonly (readonly string[])[];
      total: number;
      stale: boolean;
    }>
  | Readonly<{ kind: 'pages'; itemCount: number; stale: boolean }>
  | Readonly<{ kind: 'missing'; sheets: readonly string[]; stale: boolean }>
  | Readonly<{ kind: 'failed'; stale: boolean }>;

/**
 * What a Read file test says about its sheet: the first rows it read, the
 * page count, or the workbook's real sheet names when the chosen one didn't
 * exist. The editor never opens the file itself.
 */
export function sheetPreview(
  test: Readonly<{ preview: PreviewRunSummary; stale: boolean }> | undefined,
): SheetPreview {
  if (test === undefined) return { kind: 'untested' };
  const { preview, stale } = test;
  if (preview.status === 'queued' || preview.status === 'running')
    return { kind: 'testing' };
  if (preview.status !== 'succeeded') {
    const sheets =
      preview.safeErrorCode === 'execution.file_input'
        ? readSheetSuggestions(preview.errorSummary ?? '')
        : [];
    return sheets.length > 0
      ? { kind: 'missing', sheets, stale }
      : { kind: 'failed', stale };
  }
  const value: unknown =
    preview.output?.kind === 'inline' ? preview.output.value : null;
  const pages = filePageBundleSchema.safeParse(value);
  if (pages.success)
    return { kind: 'pages', itemCount: pages.data.itemCount, stale };
  if (!Array.isArray(value)) return { kind: 'failed', stale };
  const records = (value as readonly unknown[]).filter(
    (item): item is Readonly<Record<string, unknown>> =>
      typeof item === 'object' && item !== null && !Array.isArray(item),
  );
  const headers = Object.keys(records[0] ?? {}).slice(0, PREVIEW_COLUMNS);
  return {
    kind: 'rows',
    headers,
    rows: records
      .slice(0, SHEET_PREVIEW_ROWS)
      .map((record) => headers.map((name) => sheetCellText(record[name]))),
    total: value.length,
    stale,
  };
}

/** A cell as the grid shows it: text as written, other values as JSON. */
export function sheetCellText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}
