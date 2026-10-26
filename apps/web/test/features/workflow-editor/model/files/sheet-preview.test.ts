import { describe, expect, it } from 'vitest';
import type { PreviewRunSummary } from '@pertexo/contracts';
import { sheetPreview } from '@/features/workflow-editor/model/inspector/files/sheet-preview';

function preview(
  overrides: Partial<PreviewRunSummary> = {},
): PreviewRunSummary {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    workflowId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    draftRevision: 3,
    nodeId: 'read',
    status: 'succeeded',
    disclosure: {
      sideEffectClass: 'safe',
      mayContactProvider: false,
      mayCauseExternalSideEffect: false,
      dryRun: 'not_supported',
    },
    output: null,
    safeErrorCode: null,
    createdAt: '2026-10-26T09:00:00.000Z',
    startedAt: '2026-10-26T09:00:00.000Z',
    completedAt: '2026-10-26T09:00:01.000Z',
    expiresAt: '2026-11-02T09:00:00.000Z',
    ...overrides,
  };
}

describe('sheet preview from the last test', () => {
  it('waits for a test, then shows the first rows and how many there were', () => {
    expect(sheetPreview(undefined)).toEqual({ kind: 'untested' });
    expect(
      sheetPreview({ preview: preview({ status: 'running' }), stale: false }),
    ).toEqual({ kind: 'testing' });
    const rows = Array.from({ length: 6 }, (_, index) => ({
      city: `City ${String(index)}`,
      sales: index * 10,
      paid: index % 2 === 0,
      note: null,
    }));
    expect(
      sheetPreview({
        preview: preview({ output: { kind: 'inline', value: rows } }),
        stale: true,
      }),
    ).toEqual({
      kind: 'rows',
      headers: ['city', 'sales', 'paid', 'note'],
      rows: [
        ['City 0', '0', 'true', ''],
        ['City 1', '10', 'false', ''],
        ['City 2', '20', 'true', ''],
        ['City 3', '30', 'false', ''],
      ],
      total: 6,
      stale: true,
    });
  });

  it('offers the workbook sheet names a missing-sheet failure lists', () => {
    expect(
      sheetPreview({
        preview: preview({
          status: 'failed',
          safeErrorCode: 'execution.file_input',
          errorSummary:
            'The workbook has no sheet with that name. Its sheets: "Q1, final", "Notes". Enter a name exactly, or leave Sheet empty to read the first visible sheet.',
        }),
        stale: false,
      }),
    ).toEqual({
      kind: 'missing',
      sheets: ['Q1, final', 'Notes'],
      stale: false,
    });
    expect(
      sheetPreview({
        preview: preview({
          status: 'failed',
          safeErrorCode: 'execution.file_input',
          errorSummary: 'The file is not a readable Excel workbook (.xlsx).',
        }),
        stale: false,
      }),
    ).toEqual({ kind: 'failed', stale: false });
  });

  it('counts paged output instead of loading it', () => {
    const page = {
      kind: 'artifact',
      artifactId: '44444444-4444-4444-8444-444444444444',
      byteLength: 10,
      mediaType: 'application/json',
      sha256: 'a'.repeat(64),
    };
    expect(
      sheetPreview({
        preview: preview({
          output: {
            kind: 'inline',
            value: { pages: [page], itemCount: 2400, pageCount: 1 },
          },
        }),
        stale: false,
      }),
    ).toEqual({ kind: 'pages', itemCount: 2400, stale: false });
  });
});
