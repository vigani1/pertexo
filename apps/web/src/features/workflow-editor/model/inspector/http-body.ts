import {
  HTTP_REQUEST_LIMITS,
  httpMultipartConfigSchema,
  httpMultipartValueSchema,
  httpPlaceholders,
  type HttpMultipartConfig,
  type HttpMultipartPart,
} from '@pertexo/integrations';
import type { WorkflowIssue } from '@/features/workflow-publish/public';
import type { GraphLevel, WorkflowNode } from '../graph/scopes';
import {
  inputMappingRowsFor,
  newInputMappingRow,
  validateInputMappingRows,
  type InputMappingDraftRow,
} from './input-mappings/draft';

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
/** A body that can't be saved always says why. */
export type BodyValidation = Readonly<
  ({ ok: true; value: HttpBodyValue } | { ok: false; error: string }) & {
    parts: Readonly<Record<string, PartErrors>>;
    knownBytes: number;
    unknownSize: boolean;
  }
>;

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
      ok: true,
      value: { multipart: undefined, inputMappings: draft.mappings },
      parts: {},
      knownBytes: 0,
      unknownSize: false,
    };
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
  const parts = metadataErrors(draft.parts, metadata);
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
      ok: false,
      error:
        'Known part data already fills 10 MB before form headers. Use smaller files or split them into separate uploads.',
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
      ok: false,
      error:
        'Finish the form parts before saving. Each part needs a name and a matching value.',
      parts,
      knownBytes,
      unknownSize,
    };
  return {
    ok: true,
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

/** The {names} an HTTP request reads from run data in its address or headers. */
export function httpRequestPlaceholders(node: WorkflowNode): readonly string[] {
  if (node.definition.key !== 'http.request') return [];
  const url = node.config.url;
  const headers = node.config.headers;
  return httpPlaceholders({
    url: typeof url === 'string' ? url : '',
    headers:
      typeof headers === 'object' && headers !== null && !Array.isArray(headers)
        ? Object.fromEntries(
            Object.entries(headers).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === 'string',
            ),
          )
        : {},
  });
}

/** Each {name} an enabled HTTP request reads but no input maps. */
export function workflowPlaceholderIssues(
  level: GraphLevel,
): readonly WorkflowIssue[] {
  return level.nodes.flatMap((node): WorkflowIssue[] => {
    const body = node.structured?.body;
    const nested = body === undefined ? [] : workflowPlaceholderIssues(body);
    if (node.disabled ?? false) return [...nested];
    return [
      ...httpRequestPlaceholders(node)
        .filter((name) => node.inputMappings[name] === undefined)
        .map((name) => ({
          id: `${node.id}:placeholder:${name}`,
          message: `Map a value for {${name}}, used in the request address or headers.`,
          target: { nodeId: node.id, mappingKey: name },
        })),
      ...nested,
    ];
  });
}

const METADATA_ERRORS = {
  name: 'Use a field name up to 128 UTF-8 bytes without control characters.',
  filename:
    'Use a filename up to 255 UTF-8 bytes, without paths or control characters.',
  contentType: 'Use a MIME type such as application/pdf, without line breaks.',
};

function metadataErrors(
  drafts: readonly FormPartDraft[],
  metadata: ReturnType<typeof httpMultipartConfigSchema.safeParse>,
): Record<string, PartErrors> {
  const errors: Record<string, PartErrors> = {};
  if (!metadata.success)
    for (const issue of metadata.error.issues) {
      const index = issue.path[1];
      const field = issue.path[2];
      const part = typeof index === 'number' ? drafts[index] : undefined;
      const editablePartMetadata =
        part !== undefined &&
        (field === 'name' || field === 'filename' || field === 'contentType');
      if (editablePartMetadata)
        errors[part.inputKey] = {
          ...errors[part.inputKey],
          [field]: METADATA_ERRORS[field],
        };
    }
  return errors;
}
