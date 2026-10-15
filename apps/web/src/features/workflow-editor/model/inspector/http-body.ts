import {
  HTTP_REQUEST_LIMITS,
  httpMultipartConfigSchema,
  httpMultipartValueSchema,
  type HttpMultipartConfig,
  type HttpMultipartPart,
} from '@pertexo/integrations';
import type { GraphLevel, WorkflowNode } from '../graph/scopes';
import {
  inputMappingRowsFor,
  newInputMappingRow,
  validateInputMappingRows,
  type InputMappingDraftRow,
} from './input-mappings';

export type HttpBodyValue = Readonly<{
  multipart: HttpMultipartConfig | undefined;
  inputMappings: WorkflowNode['inputMappings'];
}>;
export type FormPartDraft = Readonly<{
  inputKey: string;
  name: string;
  kind: 'text' | 'file';
  filename: string;
  contentType: string;
  source: InputMappingDraftRow;
}>;
export type HttpBodyDraft =
  | Readonly<{ mode: 'raw'; mappings: WorkflowNode['inputMappings'] }>
  | Readonly<{ mode: 'multipart'; parts: readonly FormPartDraft[] }>;
export type PartErrors = Readonly<{
  name?: string;
  filename?: string;
  contentType?: string;
  source?: string;
}>;
export type BodyValidation = Readonly<{
  value?: HttpBodyValue;
  error?: string;
  parts: Readonly<Record<string, PartErrors>>;
  knownBytes: number;
  unknownSize: boolean;
}>;

export function bodyValue(node: WorkflowNode): HttpBodyValue | undefined {
  if (node.config.multipart === undefined)
    return { multipart: undefined, inputMappings: node.inputMappings };
  const result = httpMultipartConfigSchema.safeParse(node.config.multipart);
  return result.success
    ? { multipart: result.data, inputMappings: node.inputMappings }
    : undefined;
}
export function bodyDraft(value: HttpBodyValue): HttpBodyDraft {
  if (value.multipart === undefined)
    return { mode: 'raw', mappings: value.inputMappings };
  const mappings = new Map(
    inputMappingRowsFor(value.inputMappings).map((row) => [
      row.destinationKey,
      row,
    ]),
  );
  return {
    mode: 'multipart',
    parts: value.multipart.parts.map((part) => ({
      ...part,
      filename: part.filename ?? '',
      contentType: part.contentType ?? '',
      source: {
        ...(mappings.get(part.inputKey) ??
          newInputMappingRow(part.inputKey, part.inputKey)),
        id: part.inputKey,
      },
    })),
  };
}
export function newFormPart(kind: 'text' | 'file'): FormPartDraft {
  const inputKey = `part_${crypto.randomUUID()}`;
  return {
    inputKey,
    name: kind === 'text' ? 'field' : 'file',
    kind,
    filename: '',
    contentType: '',
    source: {
      id: inputKey,
      destinationKey: inputKey,
      kind: 'literal',
      literalJson: kind === 'text' ? '""' : 'null',
    },
  };
}
export function populatedSource(source: InputMappingDraftRow): boolean {
  return (
    source.kind !== 'literal' ||
    (source.literalJson !== 'null' && source.literalJson !== '""')
  );
}
export function validateBodyDraft(
  draft: HttpBodyDraft,
  graph: GraphLevel,
  nodeId: string,
): BodyValidation {
  if (draft.mode === 'raw')
    return {
      value: { multipart: undefined, inputMappings: draft.mappings },
      parts: {},
      knownBytes: 0,
      unknownSize: false,
    };
  const parts: Record<string, PartErrors> = {};
  const metadata = httpMultipartConfigSchema.safeParse({
    parts: draft.parts.map(
      ({ inputKey, name, kind, filename, contentType }) => ({
        inputKey,
        name,
        kind,
        ...(filename === '' ? {} : { filename }),
        ...(contentType === '' ? {} : { contentType }),
      }),
    ),
  });
  if (!metadata.success)
    for (const issue of metadata.error.issues) {
      const index = issue.path[1];
      const field = issue.path[2];
      const part = typeof index === 'number' ? draft.parts[index] : undefined;
      if (
        part !== undefined &&
        (field === 'name' || field === 'filename' || field === 'contentType')
      )
        parts[part.inputKey] = {
          ...parts[part.inputKey],
          [field]:
            field === 'name'
              ? 'Use a field name up to 128 UTF-8 bytes without control characters.'
              : field === 'filename'
                ? 'Use a filename up to 255 UTF-8 bytes, without paths or control characters.'
                : 'Use a MIME type such as application/pdf, without line breaks.',
        };
    }
  const mappings = validateInputMappingRows(
    draft.parts.map((part) => part.source),
    graph,
    nodeId,
    { checkGraph: false },
  );
  let knownBytes = 0;
  let unknownSize = false;
  for (const part of draft.parts) {
    const sourceError = mappings.errors[part.inputKey]?.source;
    if (sourceError !== undefined)
      parts[part.inputKey] = { ...parts[part.inputKey], source: sourceError };
    const mapping = mappings.inputMappings?.[part.inputKey];
    if (mapping?.kind !== 'literal') {
      unknownSize = true;
      continue;
    }
    const value = httpMultipartValueSchema.safeParse(mapping.value);
    if (
      !value.success ||
      (part.kind === 'text') !== (typeof value.data === 'string')
    ) {
      parts[part.inputKey] = {
        ...parts[part.inputKey],
        source:
          part.kind === 'text'
            ? 'Use a text value or map text from another input.'
            : 'Upload a file or map a finalized file reference.',
      };
      continue;
    }
    knownBytes +=
      typeof value.data === 'string'
        ? new TextEncoder().encode(value.data).byteLength
        : value.data.byteLength;
  }
  if (knownBytes >= HTTP_REQUEST_LIMITS.maxRequestBodyBytes)
    return {
      error:
        'Known part data already fills 1 MB before form headers. Use smaller files or split them into separate uploads.',
      parts,
      knownBytes,
      unknownSize,
    };
  if (
    !metadata.success ||
    mappings.inputMappings === undefined ||
    Object.keys(parts).length > 0
  )
    return {
      error:
        'Finish the form parts before saving. Each part needs a name and a matching value.',
      parts,
      knownBytes,
      unknownSize,
    };
  return {
    value: { multipart: metadata.data, inputMappings: mappings.inputMappings },
    parts,
    knownBytes,
    unknownSize,
  };
}

export function applyBodyValue(value: HttpBodyValue, node: WorkflowNode) {
  const { multipart: _multipart, ...config } = node.config;
  return {
    config:
      value.multipart === undefined
        ? config
        : {
            ...config,
            multipart: {
              parts: value.multipart.parts.map((part: HttpMultipartPart) => ({
                inputKey: part.inputKey,
                name: part.name,
                kind: part.kind,
                ...(part.filename === undefined
                  ? {}
                  : { filename: part.filename }),
                ...(part.contentType === undefined
                  ? {}
                  : { contentType: part.contentType }),
              })),
            },
          },
    inputMappings: value.inputMappings,
  };
}
