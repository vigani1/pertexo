import {
  isMaskedAddress,
  type AssistantDisclosure,
} from '@pertexo/node-sdk/server';
import {
  canonicalJson,
  type WorkflowGraph,
  type WorkflowNode,
} from '@pertexo/workflow-model';

/** The disclosure that applies to a step as saved, when its definition has one. */
export type DisclosureLookup = (
  node: WorkflowNode,
) => AssistantDisclosure | undefined;

// Stands for every undeclared field of a record, whose names may be private.
const opaqueField = '@existing';
const maskedSetting = { kind: 'existing_setting' } as const;
const maskedMapping = {
  kind: 'literal',
  value: { kind: 'existing_mapping' },
} as const;
const maskedConnection = '@existing_connection';
const CONNECTION_REQUIRES_USER = 'connection_requires_user';

type Fields = AssistantDisclosure['config'] | undefined;
interface Issue {
  path: string;
  code: string;
  message: string;
}

export function projectDraftForModel(
  { notes: _notes, callable: _callable, ...graph }: WorkflowGraph,
  disclosureFor: DisclosureLookup,
): WorkflowGraph {
  return { ...graph, nodes: projectNodes(graph.nodes, disclosureFor) };
}

function projectNodes(
  nodes: readonly WorkflowNode[],
  disclosureFor: DisclosureLookup,
): WorkflowNode[] {
  return nodes.map((node) => {
    const fields = disclosureFor(node);
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
                nodes: projectNodes(structured.body.nodes, disclosureFor),
              },
            },
          }),
    };
  });
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

/**
 * Put the saved masked values back into the model's candidate. A rejection
 * also names the issues the model can correct; a connection is the user's to
 * choose.
 */
export function restoreDraftFields(
  base: WorkflowGraph,
  candidate: WorkflowGraph,
  disclosureFor: DisclosureLookup,
) {
  const restoration: Restoration = {
    issues: [],
    protectedPaths: ['$.callable', '$.notes'],
    disclosureFor,
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
    : {
        kind: 'rejected' as const,
        issues,
        feedback: issues.filter(
          ({ code }) => code !== CONNECTION_REQUIRES_USER,
        ),
      };
}

interface Restoration {
  issues: Issue[];
  protectedPaths: string[];
  disclosureFor: DisclosureLookup;
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

interface RestoringRecord<Value> {
  marker: Value;
  key: 'config' | 'inputMappings' | 'connectionRefs';
  before?: Fields;
  after?: Fields;
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
    if (!nextIds.has(node.id) && hasProtectedValues(node, restoration))
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
    if (
      duplicate &&
      original !== undefined &&
      hasProtectedValues(original, restoration)
    )
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
  if (changed && hasProtectedValues(original, restoration))
    protectedValueChanged(restoration.issues, path.byId);
  const before =
    original === undefined ? undefined : restoration.disclosureFor(original);
  const after =
    original === undefined || changed
      ? restoration.disclosureFor(node)
      : before;
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
    if (
      previousBody?.nodes.some((child) =>
        hasProtectedValues(child, restoration),
      )
    )
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
        code: CONNECTION_REQUIRES_USER,
        message: 'Select the connection in the editor.',
      });
    return after;
  }
  return restoreRecord(
    before,
    after,
    { marker: maskedConnection, key: 'connectionRefs' },
    step,
  );
}

function restoreRecord<Value>(
  before: Readonly<Record<string, Value>> | undefined,
  after: Readonly<Record<string, Value>>,
  record: RestoringRecord<Value>,
  step: RestoringStep,
): Readonly<Record<string, Value>> {
  const { values, placeholders } = keepMaskedBaseFields(
    before,
    after,
    record,
    step,
  );
  checkPlaceholders(after, placeholders, record, step);
  // A new step's values are the model's own, so it may set any field.
  if (before !== undefined)
    refuseNewMaskedFields(after, placeholders, record, step);
  return Object.fromEntries(values);
}

/** The saved value wins for every masked field; the model saw only its name. */
function keepMaskedBaseFields<Value>(
  before: Readonly<Record<string, Value>> | undefined,
  after: Readonly<Record<string, Value>>,
  record: RestoringRecord<Value>,
  { path, restoration }: RestoringStep,
) {
  const values = new Map(Object.entries(after));
  const placeholders = new Set<string>();
  for (const [key, value] of Object.entries(before ?? {})) {
    const mask = fieldMask(record.before, key, value);
    if (mask === undefined) continue;
    const field = fieldPath(record, mask);
    // The model cannot see these values, so it is not asked to fix them.
    restoration.protectedPaths.push(
      `${path.byId}.${field}`,
      `${path.byIndex}.${field}`,
    );
    values.set(key, value);
    placeholders.add(mask);
  }
  // The opaque placeholder stands for the undeclared fields restored above.
  if (
    placeholders.has(opaqueField) &&
    !Object.hasOwn(before ?? {}, opaqueField)
  )
    values.delete(opaqueField);
  return { values, placeholders };
}

/**
 * Each restored field must keep its placeholder, and a placeholder anywhere
 * else would be saved as a real value.
 */
function checkPlaceholders<Value>(
  after: Readonly<Record<string, Value>>,
  placeholders: ReadonlySet<string>,
  record: RestoringRecord<Value>,
  { path, restoration }: RestoringStep,
) {
  for (const mask of placeholders)
    if (
      !Object.hasOwn(after, mask) ||
      !isPlaceholder(record, mask, after[mask])
    )
      protectedValueChanged(
        restoration.issues,
        `${path.byId}.${fieldPath(record, mask)}`,
      );
  for (const [key, value] of Object.entries(after))
    if (!placeholders.has(key) && isPlaceholder(record, key, value))
      restoration.issues.push({
        path: `${path.byId}.${fieldPath(record, key)}`,
        code: 'masked_placeholder_copied',
        message:
          'A placeholder stands only for a saved protected setting. Set a real value or leave the field unset.',
      });
}

function refuseNewMaskedFields<Value>(
  after: Readonly<Record<string, Value>>,
  placeholders: ReadonlySet<string>,
  record: RestoringRecord<Value>,
  { path, restoration }: RestoringStep,
) {
  for (const [key, value] of Object.entries(after)) {
    if (placeholders.has(key) || isPlaceholder(record, key, value)) continue;
    const mask = fieldMask(record.after, key, value);
    if (mask !== undefined)
      restoration.issues.push({
        path: `${path.byId}.${fieldPath(record, mask)}`,
        code: 'masked_value_added',
        message: 'A protected setting was added. Set it in the editor.',
      });
  }
}

function isPlaceholder<Value>(
  record: RestoringRecord<Value>,
  key: string,
  value: Value | undefined,
): boolean {
  return (
    key === opaqueField || canonicalJson(value) === canonicalJson(record.marker)
  );
}

function fieldPath(record: RestoringRecord<unknown>, mask: string): string {
  return mask === opaqueField ? record.key : `${record.key}.${mask}`;
}

function protectedValueChanged(issues: Issue[], path: string) {
  issues.push({
    path,
    code: 'masked_value_changed',
    message:
      'A protected setting was changed or removed. Edit it in the editor.',
  });
}

/** The name a field takes in the projection, or nothing when it is visible. */
function fieldMask(
  fields: Fields,
  key: string,
  value: unknown,
): string | undefined {
  if (fields?.visible.includes(key)) return undefined;
  if (fields?.masked.includes(key)) return key;
  if (fields?.addresses?.includes(key))
    return isMaskedAddress(value) ? key : undefined;
  if (fields?.unlisted === 'visible') return undefined;
  // Unknown keys can themselves contain private data from older or incomplete drafts.
  return fields?.unlisted === 'masked' ? key : opaqueField;
}

function hasProtectedValues(
  node: WorkflowNode,
  restoration: Restoration,
): boolean {
  const fields = restoration.disclosureFor(node);
  return (
    hasEntries(node.connectionRefs) ||
    Object.entries(node.config).some(
      ([key, value]) => fieldMask(fields?.config, key, value) !== undefined,
    ) ||
    Object.entries(node.inputMappings).some(
      ([key, value]) => fieldMask(fields?.inputs, key, value) !== undefined,
    ) ||
    (node.structured?.body.nodes.some((child) =>
      hasProtectedValues(child, restoration),
    ) ??
      false)
  );
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
