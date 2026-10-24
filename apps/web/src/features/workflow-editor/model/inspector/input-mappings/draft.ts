import {
  isWorkflowTriggerDefinition,
  workspaceVariableNameSchema,
} from '@pertexo/workflow-model';
import {
  WORKFLOW_FAILURE_PORT,
  WORKFLOW_FAILURE_PATHS,
} from '@pertexo/workflow-model';
import { isRecord } from '@pertexo/workflow-model';
import { parseJsonPath } from '@pertexo/workflow-model';
import { stepTitle } from '../../graph/adapter';
import type { GraphLevel, WorkflowNode } from '../../graph/scopes';

export type InputMapping = WorkflowNode['inputMappings'][string];

type JsonValue = Extract<InputMapping, { readonly kind: 'literal' }>['value'];

export type EditableInputMappingKind = InputMapping['kind'];

type RowBase = Readonly<{ id: string; destinationKey: string }>;

export type InputMappingDraftRow =
  | (RowBase & Readonly<{ kind: 'workspace_variable'; name: string }>)
  | (RowBase & Readonly<{ kind: 'literal'; literalJson: string }>)
  | (RowBase & Readonly<{ kind: 'run_input'; path: string }>)
  | (RowBase & Readonly<{ kind: 'node_output'; nodeId: string; path: string }>)
  | (RowBase & Readonly<{ kind: 'node_failure'; nodeId: string; path: string }>)
  | (RowBase &
      Readonly<{
        kind: 'expression';
        expression: string;
      }>)
  | (RowBase &
      Readonly<{ kind: 'structured_input'; port: string; path: string }>);

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

export type PredecessorOption = Readonly<{
  nodeId: string;
  label: string;
}>;

export function inputMappingRowsFor(
  inputMappings: WorkflowNode['inputMappings'],
): readonly InputMappingDraftRow[] {
  return Object.entries(inputMappings).map(
    ([destinationKey, source], index): InputMappingDraftRow => {
      const id = `existing-${String(index)}`;
      switch (source.kind) {
        case 'workspace_variable':
          return {
            id,
            destinationKey,
            kind: 'workspace_variable',
            name: source.name,
          };
        case 'literal':
          return {
            id,
            destinationKey,
            kind: 'literal',
            literalJson: JSON.stringify(source.value, null, 2),
          };
        case 'run_input':
          return { id, destinationKey, kind: 'run_input', path: source.path };
        case 'node_failure':
        case 'node_output':
          return {
            id,
            destinationKey,
            kind: source.kind,
            nodeId: source.nodeId,
            path: source.path,
          };
        case 'expression':
          return {
            id,
            destinationKey,
            kind: 'expression',
            expression: source.expression,
          };
        case 'structured_input':
          return {
            id,
            destinationKey,
            kind: 'structured_input',
            port: source.port,
            path: source.path,
          };
      }
    },
  );
}

export function newInputMappingRow(
  id: string,
  destinationKey = '',
): InputMappingDraftRow {
  return { id, destinationKey, kind: 'literal', literalJson: 'null' };
}

export function changeInputMappingKind(
  row: InputMappingDraftRow,
  kind: EditableInputMappingKind,
  firstPredecessorId = '',
): InputMappingDraftRow {
  const base = { id: row.id, destinationKey: row.destinationKey };
  switch (kind) {
    case 'workspace_variable':
      return { ...base, kind, name: '' };
    case 'literal':
      return { ...base, kind, literalJson: 'null' };
    case 'run_input':
      return { ...base, kind, path: '$' };
    case 'node_failure':
    case 'node_output':
      return { ...base, kind, nodeId: firstPredecessorId, path: '$' };
    case 'structured_input':
      return { ...base, kind, port: 'item', path: '$' };
    case 'expression':
      return {
        ...base,
        kind,
        expression: '',
      };
  }
}

export type MappingCheckOptions = Readonly<{
  /**
   * Check sources against the graph: a step output must be wired straight
   * into this step, and a loop item needs a body port. `false` keeps such a
   * row (shown as a warning) so live editing never blocks other inputs.
   */
  checkGraph?: boolean;
  /** The inputs of the body this step is in; none outside a For each. */
  loopPorts?: readonly string[];
}>;

/** Converts rows into mappings, or says which rows can't be used yet. */
export function validateInputMappingRows(
  rows: readonly InputMappingDraftRow[],
  graph: GraphLevel,
  targetNodeId: string,
  options: MappingCheckOptions = {},
): InputMappingValidationResult {
  const errors: Record<string, InputMappingRowErrors> = {};
  const keyCounts = new Map<string, number>();
  for (const row of rows)
    keyCounts.set(
      row.destinationKey,
      (keyCounts.get(row.destinationKey) ?? 0) + 1,
    );
  const directPredecessors = new Set(
    directPredecessorOptions(graph, targetNodeId).map(({ nodeId }) => nodeId),
  );
  const check = {
    predecessors: directPredecessors,
    graph: options.checkGraph ?? true,
    loopPorts: options.loopPorts,
    failureSource: graph.edges.find(
      (edge) =>
        edge.target.nodeId === targetNodeId &&
        edge.source.port === WORKFLOW_FAILURE_PORT,
    )?.source.nodeId,
  };
  const inputMappings = Object.create(null) as Record<string, InputMapping>;
  for (const row of rows) {
    const destinationKey =
      row.destinationKey.trim() === ''
        ? 'Destination key is required.'
        : (keyCounts.get(row.destinationKey) ?? 0) > 1
          ? 'Another input already uses this field.'
          : undefined;
    const source = rowSource(row, check);
    if (destinationKey !== undefined || source.error !== undefined) {
      errors[row.id] = {
        ...(destinationKey === undefined ? {} : { destinationKey }),
        ...(source.error === undefined ? {} : { source: source.error }),
      };
      continue;
    }
    if (source.mapping !== undefined)
      inputMappings[row.destinationKey] = source.mapping;
  }
  return Object.keys(errors).length === 0
    ? { inputMappings, errors: {} }
    : { errors };
}

type SourceCheck = Readonly<{
  predecessors: ReadonlySet<string>;
  graph: boolean;
  failureSource: string | undefined;
  loopPorts: readonly string[] | undefined;
}>;

function rowSource(
  row: InputMappingDraftRow,
  check: SourceCheck,
): Readonly<{ mapping?: InputMapping; error?: string }> {
  switch (row.kind) {
    case 'workspace_variable':
      return workspaceVariableNameSchema.safeParse(row.name).success
        ? { mapping: { kind: 'workspace_variable', name: row.name } }
        : { error: 'Choose an uppercase workspace variable name.' };
    case 'literal': {
      const value = parseJsonValue(row.literalJson);
      return value === undefined
        ? { error: 'Literal value must be valid JSON.' }
        : { mapping: { kind: 'literal', value } };
    }
    case 'expression':
      return row.expression.trim() === ''
        ? { error: 'Write an expression, such as body.amount > 5000.' }
        : {
            mapping: {
              kind: 'expression',
              language: 'jsonata',
              expression: row.expression,
            },
          };
    case 'run_input':
    case 'node_failure':
    case 'node_output':
    case 'structured_input':
      break;
  }
  if (parseJsonPath(row.path) === undefined)
    return {
      error: 'Use $, dot properties, array indexes, or quoted properties.',
    };
  switch (row.kind) {
    case 'run_input':
      return { mapping: { kind: 'run_input', path: row.path } };
    case 'structured_input':
      return check.graph &&
        check.loopPorts !== undefined &&
        !check.loopPorts.includes(row.port)
        ? {
            error:
              'Only steps inside a For each body can read the loop item. Choose another source.',
          }
        : {
            mapping: {
              kind: 'structured_input',
              port: row.port,
              path: row.path,
            },
          };
    case 'node_failure':
      if (row.nodeId === '')
        return { error: 'This mapping needs a linked source failure.' };
      return (check.graph && row.nodeId !== check.failureSource) ||
        !WORKFLOW_FAILURE_PATHS.includes(row.path)
        ? {
            error:
              'Only this handler entry can read its linked source’s safe failure fields.',
          }
        : {
            mapping: {
              kind: 'node_failure',
              nodeId: row.nodeId,
              path: row.path,
            },
          };
    case 'node_output':
      break;
  }
  if (row.nodeId === '') return { error: 'Choose a linked predecessor.' };
  if (check.graph && !check.predecessors.has(row.nodeId))
    return { error: 'The source must be a directly linked predecessor.' };
  return {
    mapping: { kind: row.kind, nodeId: row.nodeId, path: row.path },
  };
}

/** Graph-consistency warnings that live editing shows but does not block. */
export function inputMappingSourceErrors(
  rows: readonly InputMappingDraftRow[],
  graph: GraphLevel,
  targetNodeId: string,
  loopPorts?: readonly string[],
): Readonly<Record<string, InputMappingRowErrors>> {
  const validated = validateInputMappingRows(
    rows,
    graph,
    targetNodeId,
    loopPorts === undefined ? {} : { loopPorts },
  );
  return Object.fromEntries(
    Object.entries(validated.errors).flatMap(([rowId, error]) =>
      error.source === undefined
        ? []
        : [[rowId, { source: error.source }] as const],
    ),
  );
}

/** A JSON path for one top-level property: `$.amount` or `$['a-b']`. */
export function propertyPath(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)
    ? `$.${key}`
    : `$['${key.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}']`;
}

export function directPredecessorOptions(
  graph: GraphLevel,
  targetNodeId: string,
): readonly PredecessorOption[] {
  const predecessorIds = new Set(
    graph.edges.flatMap((edge) =>
      edge.target.nodeId === targetNodeId &&
      edge.source.port !== WORKFLOW_FAILURE_PORT
        ? [edge.source.nodeId]
        : [],
    ),
  );
  return graph.nodes.flatMap((node) =>
    predecessorIds.has(node.id)
      ? [{ nodeId: node.id, label: stepTitle(node) }]
      : [],
  );
}

export function nodeUsesRunInputDirectly(
  definition: WorkflowNode['definition'],
): boolean {
  return isWorkflowTriggerDefinition(definition);
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
  value: unknown,
): value is EditableInputMappingKind {
  return (
    value === 'workspace_variable' ||
    value === 'literal' ||
    value === 'run_input' ||
    value === 'node_output' ||
    value === 'node_failure' ||
    value === 'expression' ||
    value === 'structured_input'
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
