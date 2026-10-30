import jsonata from 'jsonata';
import { describe, expect, it } from 'vitest';
import type { GraphLevel } from '@/features/workflow-editor/model/graph/scopes';
import {
  attachmentName,
  attachmentsDraft,
  attachmentsSize,
  checkAttachments,
  newAttachment,
  type AttachmentDraft,
} from '@/features/workflow-editor/model/inspector/object-mappings/attachments';

const graph = { nodes: [], edges: [] } as unknown as GraphLevel;

function file(byteLength: number, mediaType = 'text/csv; charset=utf-8') {
  return {
    kind: 'artifact' as const,
    artifactId: 'abababab-abab-4bab-8bab-abababababab',
    byteLength,
    mediaType,
    sha256: 'a'.repeat(64),
  };
}

function rows(draft: ReturnType<typeof attachmentsDraft>) {
  if (draft.mode !== 'files') throw new Error('Expected separate files');
  return draft.rows;
}

function named(row: AttachmentDraft, filename: string): AttachmentDraft {
  return { ...row, filename };
}

describe('email attachments in the inspector', () => {
  it('saves mapped files as one JSONata list that evaluates to the step input', async () => {
    const report = named(
      newAttachment({ kind: 'node_output', nodeId: 'create', path: '$.file' }),
      'weekly "report".csv',
    );
    const passedIn = newAttachment({ kind: 'run_input', path: '$.file' });
    const checked = checkAttachments(
      { mode: 'files', rows: [report, passedIn] },
      graph,
      'email',
    );
    if (!checked.ok || checked.mapping?.kind !== 'expression')
      throw new Error('Expected a list expression');
    const value: unknown = await jsonata(checked.mapping.expression).evaluate({
      nodeOutputs: { create: { file: file(10) } },
      runInput: { file: file(20, 'application/pdf') },
    });
    expect(value).toEqual([
      { file: file(10), filename: 'weekly "report".csv' },
      { file: file(20, 'application/pdf') },
    ]);
    // Reading the saved mapping gives back the same rows.
    const reread = rows(attachmentsDraft(checked.mapping));
    expect(
      reread.map(({ file: source, filename }) => ({ source, filename })),
    ).toEqual([
      {
        source: expect.objectContaining({
          kind: 'node_output',
          nodeId: 'create',
          path: '$.file',
        }) as unknown,
        filename: 'weekly "report".csv',
      },
      {
        source: expect.objectContaining({
          kind: 'run_input',
          path: '$.file',
        }) as unknown,
        filename: '',
      },
    ]);
  });

  it('keeps uploaded files as a plain list value', () => {
    const terms = named(
      newAttachment({
        kind: 'literal',
        value: file(1_342_177, 'application/pdf'),
      }),
      'Terms.pdf',
    );
    const checked = checkAttachments(
      { mode: 'files', rows: [terms] },
      graph,
      'email',
    );
    if (!checked.ok) throw new Error('Expected a mapping');
    expect(checked.mapping).toEqual({
      kind: 'literal',
      value: [
        { file: file(1_342_177, 'application/pdf'), filename: 'Terms.pdf' },
      ],
    });
    expect(rows(attachmentsDraft(checked.mapping))[0]?.filename).toBe(
      'Terms.pdf',
    );
  });

  it('removes the mapping when no files are left, as for an old email step', () => {
    expect(
      checkAttachments({ mode: 'files', rows: [] }, graph, 'email'),
    ).toEqual({ ok: true, mapping: undefined });
    expect(attachmentsDraft(undefined)).toEqual({ mode: 'files', rows: [] });
  });

  it('keeps a list mapped as a whole, such as a Code step’s files', () => {
    const whole = {
      kind: 'node_output',
      nodeId: 'code',
      path: '$.files',
    } as const;
    const draft = attachmentsDraft(whole);
    expect(draft.mode).toBe('list');
    expect(checkAttachments(draft, graph, 'email')).toEqual({
      ok: true,
      mapping: whole,
    });
    expect(
      attachmentsDraft({
        kind: 'expression',
        language: 'jsonata',
        expression: '$map(nodeOutputs.code.files, function($f) {{"file": $f}})',
      }).mode,
    ).toBe('list');
  });

  it('asks for a file before saving an attachment without one', () => {
    const empty = newAttachment();
    const checked = checkAttachments(
      { mode: 'files', rows: [empty] },
      graph,
      'email',
    );
    expect(checked).toEqual({
      ok: false,
      rowErrors: {
        [empty.id]: 'Choose a file from an earlier step or upload one.',
      },
    });
  });

  it('refuses an eleventh file', () => {
    const eleven = Array.from({ length: 11 }, () =>
      newAttachment({ kind: 'literal', value: file(3) }),
    );
    expect(
      checkAttachments({ mode: 'files', rows: eleven }, graph, 'email'),
    ).toEqual({ ok: false, error: 'An email can carry at most 10 files.' });
    expect(
      checkAttachments({ mode: 'files', rows: eleven.slice(1) }, graph, 'email')
        .ok,
    ).toBe(true);
  });

  it('measures known files after base64 and counts mapped ones for later', () => {
    const fixed = newAttachment({ kind: 'literal', value: file(3_000_000) });
    const mapped = newAttachment({ kind: 'run_input', path: '$.file' });
    expect(attachmentsSize([fixed, mapped])).toMatchObject({
      count: 2,
      bytes: 3_000_000,
      unknown: 1,
      over: false,
      limitBytes: 6 * 1_048_576,
    });
    expect(attachmentsSize([fixed]).fraction).toBeCloseTo(
      4_000_000 / (8 * 1_048_576),
    );
    const large = newAttachment({
      kind: 'literal',
      value: file(6 * 1_048_576 + 1),
    });
    expect(attachmentsSize([large]).over).toBe(true);
  });

  it('shows the name recipients will see', () => {
    const pdf = newAttachment({
      kind: 'literal',
      value: file(3, 'application/pdf'),
    });
    expect(attachmentName(pdf, { index: 1, count: 2 })).toEqual({
      name: 'attachment-2.pdf',
      chosen: false,
    });
    expect(
      attachmentName(named(pdf, '  q3/report.pdf '), { index: 0, count: 1 }),
    ).toEqual({
      name: 'q3report.pdf',
      chosen: true,
    });
    expect(
      attachmentName(newAttachment({ kind: 'run_input', path: '$.file' }), {
        index: 0,
        count: 1,
      }),
    ).toEqual({ name: undefined, chosen: false });
  });
});
