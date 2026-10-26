import {
  EMAIL_SEND_NOTIFICATION_LIMITS,
  defaultAttachmentFilename,
  emailAttachmentSchema,
  encodedAttachmentBytes,
  sanitizeAttachmentFilename,
} from '@pertexo/integrations';
import { canonicalJson, type ValueSource } from '@pertexo/workflow-model';
import type { GraphLevel } from '../../graph/scopes';
import {
  inputMappingRowsFor,
  validateInputMappingRows,
  type InputMappingDraftRow,
} from '../input-mappings/draft';
import { listExpressions } from './expressions';
import { valueExpression } from './sources';

type FileReference = ReturnType<typeof emailAttachmentSchema.parse>['file'];

/** One attached file: where its reference comes from and an optional name. */
export type AttachmentDraft = Readonly<{
  id: string;
  file: InputMappingDraftRow;
  filename: string;
}>;

/**
 * Attachments as separate files, or one list mapped as a whole (such as a
 * Code step's output), which stays editable as its single mapping.
 */
export type AttachmentsDraft =
  | Readonly<{ mode: 'files'; rows: readonly AttachmentDraft[] }>
  | Readonly<{ mode: 'list'; source: InputMappingDraftRow }>;

export type AttachmentsCheck = Readonly<{
  /** The mapping to save; undefined removes it, as for an email without files. */
  mapping?: ValueSource | undefined;
  /** Why the draft can't be saved yet, by row. */
  errors: Readonly<Record<string, string>>;
  error?: string;
}>;

export const ATTACHMENTS_KEY = 'attachments';

function fileRow(id: string, source: ValueSource): InputMappingDraftRow {
  const row = inputMappingRowsFor({ [id]: source })[0];
  if (row === undefined) throw new TypeError('A mapping always has one row');
  return { ...row, id, destinationKey: id };
}

export function newAttachment(
  file: ValueSource = { kind: 'literal', value: null },
): AttachmentDraft {
  const id = `attachment-${crypto.randomUUID()}`;
  return { id, file: fileRow(id, file), filename: '' };
}

function literalRows(value: unknown): AttachmentDraft[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows: AttachmentDraft[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = emailAttachmentSchema.safeParse(item);
    if (!parsed.success) return undefined;
    const id = `attachment-${String(index)}`;
    rows.push({
      id,
      file: fileRow(id, { kind: 'literal', value: parsed.data.file }),
      filename: parsed.data.filename ?? '',
    });
  }
  return rows;
}

function expressionRows(expression: string): AttachmentDraft[] | undefined {
  const objects = listExpressions(expression);
  if (objects === undefined) return undefined;
  const rows: AttachmentDraft[] = [];
  for (const [index, entries] of objects.entries()) {
    const file = entries.find(({ key }) => key === 'file');
    const name = entries.find(({ key }) => key === 'filename');
    if (
      file === undefined ||
      entries.some(({ key }) => key !== 'file' && key !== 'filename')
    )
      return undefined;
    let filename = '';
    if (name !== undefined) {
      try {
        const parsed: unknown = JSON.parse(name.expression);
        if (typeof parsed !== 'string') return undefined;
        filename = parsed;
      } catch {
        return undefined;
      }
    }
    const id = `attachment-${String(index)}`;
    rows.push({
      id,
      file: fileRow(
        id,
        file.source ?? {
          kind: 'expression',
          language: 'jsonata',
          expression: file.expression,
        },
      ),
      filename,
    });
  }
  return rows;
}

function composedRows(source: ValueSource): AttachmentDraft[] | undefined {
  if (source.kind === 'literal') return literalRows(source.value);
  if (source.kind === 'expression') return expressionRows(source.expression);
  return undefined;
}

export function attachmentsDraft(
  source: ValueSource | undefined,
): AttachmentsDraft {
  if (source === undefined) return { mode: 'files', rows: [] };
  const rows = composedRows(source);
  return rows === undefined
    ? { mode: 'list', source: fileRow(ATTACHMENTS_KEY, source) }
    : { mode: 'files', rows };
}

/** The file reference a row names directly, when it is a fixed (uploaded) file. */
export function literalFile(row: AttachmentDraft): FileReference | undefined {
  if (row.file.kind !== 'literal') return undefined;
  try {
    const parsed = emailAttachmentSchema
      .unwrap()
      .shape.file.safeParse(JSON.parse(row.file.literalJson));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The name recipients will see, exactly as the step will send it. A mapped
 * file without a chosen name is named from its type when sent: undefined.
 */
export function attachmentName(
  row: AttachmentDraft,
  position: Readonly<{ index: number; count: number }>,
): Readonly<{ name: string | undefined; chosen: boolean }> {
  const chosen = sanitizeAttachmentFilename(row.filename);
  if (chosen !== undefined) return { name: chosen, chosen: true };
  const file = literalFile(row);
  return {
    name:
      file === undefined
        ? undefined
        : defaultAttachmentFilename(file.mediaType, position),
    chosen: false,
  };
}

/** What the editor can measure before the run: fixed files have known sizes. */
export function attachmentsSize(rows: readonly AttachmentDraft[]) {
  let bytes = 0;
  let encoded = 0;
  let unknown = 0;
  for (const row of rows) {
    const file = literalFile(row);
    if (file === undefined) unknown += 1;
    else {
      bytes += file.byteLength;
      encoded += encodedAttachmentBytes(file.byteLength);
    }
  }
  const limit = EMAIL_SEND_NOTIFICATION_LIMITS.maxAttachmentEncodedBytes;
  return {
    count: rows.length,
    bytes,
    unknown,
    /** Encoded share of the limit; Resend measures attachments after base64. */
    fraction: encoded / limit,
    over: encoded > limit,
    /** The limit in file bytes, which is what people see as a file's size. */
    limitBytes: (limit / 4) * 3,
  };
}

function listMapping(
  rows: readonly AttachmentDraft[],
  mappings: Readonly<Record<string, ValueSource>>,
): ValueSource | undefined {
  const sources = rows.map((row) => mappings[row.id]);
  const literals = sources.every((source) => source?.kind === 'literal');
  if (literals)
    return {
      kind: 'literal',
      value: rows.map((row, index) => {
        const source = sources[index];
        return {
          file: source?.kind === 'literal' ? source.value : null,
          ...(row.filename.trim() === '' ? {} : { filename: row.filename }),
        };
      }),
    };
  const items: string[] = [];
  for (const [index, row] of rows.entries()) {
    const source = sources[index];
    const value = source === undefined ? undefined : valueExpression(source);
    if (value === undefined) return undefined;
    const name =
      row.filename.trim() === ''
        ? ''
        : `, "filename": ${JSON.stringify(row.filename)}`;
    items.push(`  {"file": (${value})${name}}`);
  }
  return {
    kind: 'expression',
    language: 'jsonata',
    expression: `[\n${items.join(',\n')}\n]`,
  };
}

/** Checks the rows and builds the one `attachments` mapping they save as. */
export function checkAttachments(
  draft: AttachmentsDraft,
  graph: GraphLevel,
  nodeId: string,
): AttachmentsCheck {
  const rows =
    draft.mode === 'files' ? draft.rows.map((row) => row.file) : [draft.source];
  const checked = validateInputMappingRows(rows, graph, nodeId, {
    checkGraph: false,
  });
  if (checked.inputMappings === undefined)
    return {
      errors: Object.fromEntries(
        Object.entries(checked.errors).map(([id, error]) => [
          id,
          error.source ?? 'Choose where this file comes from.',
        ]),
      ),
    };
  if (draft.mode === 'list')
    return { mapping: checked.inputMappings[ATTACHMENTS_KEY], errors: {} };
  const errors: Record<string, string> = {};
  for (const row of draft.rows)
    if (row.file.kind === 'literal' && literalFile(row) === undefined)
      errors[row.id] = 'Choose a file from an earlier step or upload one.';
  if (Object.keys(errors).length > 0) return { errors };
  if (draft.rows.length > EMAIL_SEND_NOTIFICATION_LIMITS.maxAttachments)
    return {
      errors: {},
      error: `An email can carry at most ${String(EMAIL_SEND_NOTIFICATION_LIMITS.maxAttachments)} files.`,
    };
  if (draft.rows.length === 0) return { mapping: undefined, errors: {} };
  const mapping = listMapping(draft.rows, checked.inputMappings);
  return mapping === undefined
    ? {
        errors: {},
        error:
          'Use a file, run input, earlier step output, variable or expression.',
      }
    : { mapping, errors: {} };
}

export function sameAttachments(
  left: ValueSource | undefined,
  right: ValueSource | undefined,
): boolean {
  return canonicalJson(left ?? null) === canonicalJson(right ?? null);
}
