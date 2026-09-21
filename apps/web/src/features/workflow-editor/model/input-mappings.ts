import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { parseJsonPath } from '@pertexo/workflow-model/json-path';

type WorkflowNode = WorkflowGraphContract['nodes'][number];
export type InputMapping = WorkflowNode['inputMappings'][string];
type JsonValue = Extract<InputMapping, { readonly kind: 'literal' }>['value'];
export type EditableInputMappingKind = Extract<
  InputMapping,
  { readonly kind: 'literal' | 'run_input' | 'node_output' }
>['kind'];

export type InputMappingDraftRow =
  | Readonly<{
      id: string;
      destinationKey: string;
      kind: 'literal';
      literalJson: string;
    }>
  | Readonly<{
      id: string;
      destinationKey: string;
      kind: 'run_input';
      path: string;
    }>
  | Readonly<{
      id: string;
      destinationKey: string;
      kind: 'node_output';
      nodeId: string;
      path: string;
    }>
  | Readonly<{
      id: string;
      destinationKey: string;
      kind: 'advanced';
      source: Extract<
        InputMapping,
        { readonly kind: 'expression' | 'structured_input' }
      >;
    }>;

export type InputMappingRowErrors = Readonly<{
  destinationKey?: string;
  source?: string;
}>;

export type InputMappingValidationResult =
  | Readonly<{
      inputMappings: WorkflowNode['inputMappings'];
      errors: Readonly<Record<string, never>>;
    }>
  | Readonly<{
      inputMappings?: never;
      errors: Readonly<Record<string, InputMappingRowErrors>>;
    }>;

export type InputKeySuggestion = Readonly<{
  key: string;
  label: string;
  description?: string;
}>;

export type PredecessorOption = Readonly<{
  nodeId: string;
  label: string;
}>;

export function inputMappingRowsFor(
  inputMappings: WorkflowNode['inputMappings'],
): readonly InputMappingDraftRow[] {
  return Object.entries(inputMappings).map(
    ([destinationKey, source], index) => {
      const id = `existing-${String(index)}`;
      if (source.kind === 'literal')
        return {
          id,
          destinationKey,
          kind: 'literal',
          literalJson: JSON.stringify(source.value, null, 2),
        };
      if (source.kind === 'run_input')
        return { id, destinationKey, kind: 'run_input', path: source.path };
      if (source.kind === 'node_output')
        return {
          id,
          destinationKey,
          kind: 'node_output',
          nodeId: source.nodeId,
          path: source.path,
        };
      return { id, destinationKey, kind: 'advanced', source };
    },
  );
}

export function newInputMappingRow(id: string): InputMappingDraftRow {
  return {
    id,
    destinationKey: '',
    kind: 'literal',
    literalJson: 'null',
  };
}

export function changeInputMappingKind(
  row: Exclude<InputMappingDraftRow, { readonly kind: 'advanced' }>,
  kind: EditableInputMappingKind,
  firstPredecessorId = '',
): InputMappingDraftRow {
  if (kind === 'literal')
    return {
      id: row.id,
      destinationKey: row.destinationKey,
      kind,
      literalJson: 'null',
    };
  if (kind === 'run_input')
    return {
      id: row.id,
      destinationKey: row.destinationKey,
      kind,
      path: '$',
    };
  return {
    id: row.id,
    destinationKey: row.destinationKey,
    kind,
    nodeId: firstPredecessorId,
    path: '$',
  };
}

export function validateInputMappingRows(
  rows: readonly InputMappingDraftRow[],
  graph: WorkflowGraphContract,
  targetNodeId: string,
): InputMappingValidationResult {
  const errors: Record<string, InputMappingRowErrors> = {};
  const keyOwners = new Map<string, string[]>();
  for (const row of rows) {
    const owners = keyOwners.get(row.destinationKey) ?? [];
    owners.push(row.id);
    keyOwners.set(row.destinationKey, owners);
  }

  const directPredecessors = new Set(
    directPredecessorOptions(graph, targetNodeId).map(({ nodeId }) => nodeId),
  );
  const inputMappings = Object.create(null) as Record<string, InputMapping>;
  for (const row of rows) {
    let destinationKeyError: string | undefined;
    let sourceError: string | undefined;
    if (row.destinationKey.trim() === '')
      destinationKeyError = 'Destination key is required.';
    else if ((keyOwners.get(row.destinationKey)?.length ?? 0) > 1)
      destinationKeyError = 'Destination keys must be unique.';

    let source: InputMapping | undefined;
    if (row.kind === 'advanced') source = row.source;
    else if (row.kind === 'literal') {
      const value = parseJsonValue(row.literalJson);
      if (value === undefined)
        sourceError = 'Literal value must be valid JSON.';
      else source = { kind: 'literal', value };
    } else if (parseJsonPath(row.path) === undefined)
      sourceError =
        'Use $, dot properties, array indexes, or quoted properties.';
    else if (row.kind === 'run_input')
      source = { kind: 'run_input', path: row.path };
    else if (row.nodeId === '') sourceError = 'Choose a connected predecessor.';
    else if (!directPredecessors.has(row.nodeId))
      sourceError = 'The source must be a directly connected predecessor.';
    else source = { kind: 'node_output', nodeId: row.nodeId, path: row.path };

    if (destinationKeyError !== undefined || sourceError !== undefined) {
      errors[row.id] = {
        ...(destinationKeyError === undefined
          ? {}
          : { destinationKey: destinationKeyError }),
        ...(sourceError === undefined ? {} : { source: sourceError }),
      };
      continue;
    }
    if (source !== undefined) inputMappings[row.destinationKey] = source;
  }

  return Object.keys(errors).length === 0
    ? { inputMappings, errors: {} }
    : { errors };
}

export function inputMappingSourceErrors(
  rows: readonly InputMappingDraftRow[],
  graph: WorkflowGraphContract,
  targetNodeId: string,
): Readonly<Record<string, InputMappingRowErrors>> {
  const validated = validateInputMappingRows(rows, graph, targetNodeId);
  return Object.fromEntries(
    Object.entries(validated.errors).flatMap(([rowId, error]) =>
      error.source === undefined
        ? []
        : [[rowId, { source: error.source }] as const],
    ),
  );
}

export function inputKeySuggestions(
  inputSchema: NodeDefinitionCatalogItem['inputSchema'] | undefined,
): readonly InputKeySuggestion[] {
  if (!isRecord(inputSchema) || Reflect.get(inputSchema, 'type') !== 'object')
    return [];
  const properties = Reflect.get(inputSchema, 'properties');
  if (!isRecord(properties)) return [];
  return Object.entries(properties).map(([key, candidate]) => {
    if (!isRecord(candidate)) return { key, label: key };
    const title = Reflect.get(candidate, 'title');
    const description = Reflect.get(candidate, 'description');
    return {
      key,
      label: typeof title === 'string' ? title : key,
      ...(typeof description === 'string' ? { description } : {}),
    };
  });
}

export function directPredecessorOptions(
  graph: WorkflowGraphContract,
  targetNodeId: string,
): readonly PredecessorOption[] {
  const predecessorIds = new Set(
    graph.edges.flatMap((edge) =>
      edge.target.nodeId === targetNodeId ? [edge.source.nodeId] : [],
    ),
  );
  return graph.nodes.flatMap((node) =>
    predecessorIds.has(node.id)
      ? [
          {
            nodeId: node.id,
            label: node.label ?? node.definition.key,
          },
        ]
      : [],
  );
}

export function nodeUsesRunInputDirectly(
  definition: WorkflowNode['definition'],
): boolean {
  return (
    (definition.key === 'core.manual' && definition.version === 1) ||
    (definition.key === 'core.webhook' && definition.version === 1) ||
    (definition.key === 'core.schedule' &&
      (definition.version === 1 ||
        definition.version === 2 ||
        definition.version === 3))
  );
}

export function inputMappingKeyControlId(
  nodeId: string,
  rowId: string,
): string {
  return `input-mapping-${nodeId}-${rowId}-key`;
}

export function inputMappingSourceControlId(
  nodeId: string,
  rowId: string,
): string {
  return `input-mapping-${nodeId}-${rowId}-source`;
}

export function isEditableInputMappingKind(
  value: string,
): value is EditableInputMappingKind {
  return (
    value === 'literal' || value === 'run_input' || value === 'node_output'
  );
}

function parseJsonValue(value: string): JsonValue | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isJsonValue(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
