import {
  PlatformNodeDefinitionUnavailableError,
  resolvePlatformNodeDefinition,
} from '@pertexo/node-catalog';
import type { AssistantDisclosure } from '@pertexo/node-sdk/server';
import {
  canonicalJson,
  type WorkflowGraph,
  type WorkflowNode,
} from '@pertexo/workflow-model';

const opaqueField = '@existing';
const maskedSetting = { kind: 'existing_setting' } as const;
const maskedMapping = {
  kind: 'literal',
  value: { kind: 'existing_mapping' },
} as const;
const maskedConnection = '@existing_connection';

type Fields = AssistantDisclosure['config'] | undefined;
interface Issue {
  path: string;
  code: string;
  message: string;
}

export const protectedSettingRefusal = {
  path: '$',
  code: 'masked_value_changed',
  message: 'Edit this protected setting in the editor.',
} as const;

export function projectDraftForModel({
  notes: _notes,
  callable: _callable,
  ...graph
}: WorkflowGraph): WorkflowGraph {
  return { ...graph, nodes: graph.nodes.map(projectNode) };
}

export function restoreDraftFields(
  base: WorkflowGraph,
  candidate: WorkflowGraph,
) {
  const restoration: Restoration = {
    issues: [],
    protectedPaths: ['$.callable', '$.notes'],
  };
  for (const field of ['notes', 'callable'] as const)
    if (base[field] !== undefined && candidate[field] !== undefined)
      protectedValueChanged(restoration.issues, `$.${field}`);
  const graph = {
    ...candidate,
    ...(base.notes === undefined ? {} : { notes: base.notes }),
    ...(base.callable === undefined ? {} : { callable: base.callable }),
    nodes: restoreNodes(
      base.nodes,
      candidate.nodes,
      { byId: '$', byIndex: '$' },
      restoration,
    ),
  };
  const { issues, protectedPaths } = restoration;
  return issues.length === 0
    ? { kind: 'ready' as const, graph, protectedPaths }
    : { kind: 'rejected' as const, issues };
}

interface Restoration {
  issues: Issue[];
  protectedPaths: string[];
}

// Publication reports both ID-based paths and paths with candidate indexes.
interface DraftPath {
  byId: string;
  byIndex: string;
}

interface RestoringStep {
  path: DraftPath;
  restoration: Restoration;
}

function restoreNodes(
  previous: readonly WorkflowNode[],
  next: readonly WorkflowNode[],
  scope: DraftPath,
  restoration: Restoration,
): readonly WorkflowNode[] {
  const byId = new Map(previous.map((node) => [node.id, node]));
  const nextIds = new Set(next.map((node) => node.id));
  for (const node of previous)
    if (!nextIds.has(node.id) && hasProtectedValues(node))
      protectedValueChanged(
        restoration.issues,
        `${scope.byId}.nodes.${node.id}`,
      );
  return next.map((node, index) => {
    const path = {
      byId: `${scope.byId}.nodes.${node.id}`,
      byIndex: `${scope.byIndex}.nodes[${String(index)}]`,
    };
    const original = byId.get(node.id);
    const duplicate = !nextIds.delete(node.id);
    if (duplicate && original !== undefined && hasProtectedValues(original))
      protectedValueChanged(restoration.issues, path.byId);
    return restoreNode(original, node, path, restoration);
  });
}

function restoreNode(
  original: WorkflowNode | undefined,
  node: WorkflowNode,
  path: DraftPath,
  restoration: Restoration,
): WorkflowNode {
  const changed = original !== undefined && changedDefinition(original, node);
  if (changed && hasProtectedValues(original))
    protectedValueChanged(restoration.issues, path.byId);
  const before = disclosure(original);
  const after = original === undefined || changed ? disclosure(node) : before;
  const step = { path, restoration };
  const config = restoreRecord(
    original?.config,
    node.config,
    {
      marker: maskedSetting,
      key: 'config',
      before: before?.config,
      after: after?.config,
    },
    step,
  );
  const inputMappings = restoreRecord(
    original?.inputMappings,
    node.inputMappings,
    {
      marker: maskedMapping,
      key: 'inputMappings',
      before: before?.inputs,
      after: after?.inputs,
    },
    step,
  );
  const connectionRefs = restoreConnections(
    original?.connectionRefs,
    node.connectionRefs,
    step,
  );
  const previousBody = original?.structured?.body;
  const structured = node.structured;
  const restored = { ...node, config, inputMappings, connectionRefs };
  if (structured === undefined) {
    if (previousBody?.nodes.some(hasProtectedValues))
      protectedValueChanged(restoration.issues, `${path.byId}.structured`);
    return restored;
  }
  return {
    ...restored,
    structured: {
      ...structured,
      body: {
        ...structured.body,
        nodes: restoreNodes(
          previousBody?.nodes ?? [],
          structured.body.nodes,
          {
            byId: `${path.byId}.structured.body`,
            byIndex: `${path.byIndex}.structured.body`,
          },
          restoration,
        ),
      },
    },
  };
}

function restoreConnections(
  before: WorkflowNode['connectionRefs'] | undefined,
  after: WorkflowNode['connectionRefs'],
  step: RestoringStep,
) {
  if (!hasEntries(before)) {
    if (hasEntries(after))
      step.restoration.issues.push({
        path: `${step.path.byId}.connectionRefs`,
        code: 'connection_requires_user',
        message: 'Select the connection in the editor.',
      });
    return after;
  }
  return restoreRecord(
    before,
    after,
    {
      marker: maskedConnection,
      key: 'connectionRefs',
    },
    step,
  );
}

function restoreRecord<Value>(
  before: Readonly<Record<string, Value>> | undefined,
  after: Readonly<Record<string, Value>>,
  record: Readonly<{
    marker: Value;
    key: 'config' | 'inputMappings' | 'connectionRefs';
    before?: Fields;
    after?: Fields;
  }>,
  { path, restoration }: RestoringStep,
): Readonly<Record<string, Value>> {
  const result = new Map(Object.entries(after));
  const markers = new Set<string>();
  for (const [key, value] of Object.entries(before ?? {})) {
    const mask = fieldMask(record.before, key, value);
    if (mask === undefined) continue;
    protect(mask);
    result.set(key, value);
    markers.add(mask);
  }
  for (const mask of markers)
    if (
      !Object.hasOwn(after, mask) ||
      canonicalJson(after[mask]) !== canonicalJson(record.marker)
    )
      protectedValueChanged(restoration.issues, `${path.byId}.${suffix(mask)}`);
  if (markers.has(opaqueField) && !Object.hasOwn(before ?? {}, opaqueField))
    result.delete(opaqueField);
  for (const [key, value] of Object.entries(after)) {
    if (markers.has(key)) continue;
    const mask = fieldMask(record.after, key, value);
    if (mask === undefined) continue;
    protect(mask);
    if (before !== undefined)
      restoration.issues.push({
        path: `${path.byId}.${suffix(mask)}`,
        code: 'masked_value_added',
        message: 'A protected setting was added. Set it in the editor.',
      });
  }
  return Object.fromEntries(result);

  function suffix(mask: string) {
    return mask === opaqueField ? record.key : `${record.key}.${mask}`;
  }

  function protect(mask: string) {
    const field = suffix(mask);
    restoration.protectedPaths.push(
      `${path.byId}.${field}`,
      `${path.byIndex}.${field}`,
    );
  }
}

function protectedValueChanged(issues: Issue[], path: string) {
  issues.push({
    path,
    code: 'masked_value_changed',
    message:
      'A protected setting was changed or removed. Edit it in the editor.',
  });
}

function projectNode(node: WorkflowNode): WorkflowNode {
  const fields = disclosure(node);
  const { structured, ...rest } = node;
  return {
    ...rest,
    config: projectRecord(node.config, fields?.config, maskedSetting),
    inputMappings: projectRecord(
      node.inputMappings,
      fields?.inputs,
      maskedMapping,
    ),
    connectionRefs: projectRecord(
      node.connectionRefs,
      undefined,
      maskedConnection,
    ),
    ...(structured === undefined
      ? {}
      : {
          structured: {
            ...structured,
            body: {
              ...structured.body,
              nodes: structured.body.nodes.map(projectNode),
            },
          },
        }),
  };
}

function projectRecord<Value>(
  record: Readonly<Record<string, Value>>,
  fields: Fields,
  marker: Value,
): Readonly<Record<string, Value>> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => {
      const mask = fieldMask(fields, key, value);
      return mask === undefined ? [key, value] : [mask, marker];
    }),
  );
}

function fieldMask(
  fields: Fields,
  key: string,
  value: unknown,
): string | undefined {
  if (fields?.visible.includes(key)) return undefined;
  if (fields?.masked?.includes(key)) return key;
  if (fields?.addresses?.includes(key))
    return typeof value !== 'string' || urlHasProtectedMaterial(value)
      ? key
      : undefined;
  if (fields?.unlisted === 'visible') return undefined;
  // Unknown keys can themselves contain private data from older or incomplete drafts.
  return fields?.unlisted === 'masked' ? key : opaqueField;
}

function urlHasProtectedMaterial(value: string): boolean {
  return value.includes('?') || /:\/\/[^/?#]*@/u.test(value);
}

function hasProtectedValues(node: WorkflowNode): boolean {
  const fields = disclosure(node);
  return (
    hasEntries(node.connectionRefs) ||
    Object.entries(node.config).some(
      ([key, value]) => fieldMask(fields?.config, key, value) !== undefined,
    ) ||
    Object.entries(node.inputMappings).some(
      ([key, value]) => fieldMask(fields?.inputs, key, value) !== undefined,
    ) ||
    (node.structured?.body.nodes.some(hasProtectedValues) ?? false)
  );
}

function disclosure(
  node: WorkflowNode | undefined,
): AssistantDisclosure | undefined {
  if (node === undefined) return undefined;
  try {
    const definition = resolvePlatformNodeDefinition(node.definition);
    return node.configVersion === definition.manifest.configVersion
      ? definition.assistantDisclosure
      : undefined;
  } catch (error: unknown) {
    if (!(error instanceof PlatformNodeDefinitionUnavailableError)) throw error;
    return undefined;
  }
}

function hasEntries(record: object | undefined): boolean {
  return record !== undefined && Object.keys(record).length > 0;
}

function changedDefinition(before: WorkflowNode, after: WorkflowNode): boolean {
  return (
    before.definition.key !== after.definition.key ||
    before.definition.version !== after.definition.version ||
    before.configVersion !== after.configVersion
  );
}
