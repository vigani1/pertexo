import {
  canonicalJson,
  type WorkflowGraph,
  type WorkflowNode,
} from '@pertexo/workflow-model';

const protectedField = '@existing';
const maskedSetting = { kind: 'existing_setting' } as const;
const maskedMapping = {
  kind: 'literal',
  value: { kind: 'existing_mapping' },
} as const;
const maskedConnection = '@existing_connection';

export function projectDraftForModel({
  notes: _notes,
  callable: _callable,
  ...graph
}: WorkflowGraph): WorkflowGraph {
  return { ...graph, nodes: graph.nodes.map(projectNode) };
}

function projectNode(node: WorkflowNode): WorkflowNode {
  const { structured, ...rest } = node;
  return {
    ...rest,
    config: maskRecord(node.config, maskedSetting),
    inputMappings: maskRecord(node.inputMappings, maskedMapping),
    connectionRefs: maskRecord(node.connectionRefs, maskedConnection),
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

export function restoreDraftFields(
  base: WorkflowGraph,
  candidate: WorkflowGraph,
) {
  const issues: { path: string; code: string; message: string }[] = [];
  const changed = (path: string) =>
    issues.push({
      path,
      code: 'masked_value_changed',
      message: 'An existing protected value was changed or removed.',
    });
  for (const field of ['notes', 'callable'] as const)
    if (base[field] !== undefined && candidate[field] !== undefined)
      changed(field);
  const graph = {
    ...candidate,
    ...(base.notes === undefined ? {} : { notes: base.notes }),
    ...(base.callable === undefined ? {} : { callable: base.callable }),
    nodes: restoreNodes(base.nodes, candidate.nodes, '$'),
  };
  return issues.length === 0
    ? { kind: 'ready' as const, graph }
    : { kind: 'rejected' as const, issues };

  function restoreNodes(
    previous: readonly WorkflowNode[],
    next: readonly WorkflowNode[],
    scope: string,
  ): readonly WorkflowNode[] {
    const byId = new Map(previous.map((node) => [node.id, node]));
    const nextIds = new Set(next.map((node) => node.id));
    for (const node of previous) {
      if (!nextIds.has(node.id) && hasProtectedValues(node))
        changed(`${scope}.nodes.${node.id}`);
    }
    return next.map((node, index) => {
      const path = `${scope}.nodes[${String(index)}]`;
      const original = byId.get(node.id);
      const duplicate = !nextIds.delete(node.id);
      if (
        original !== undefined &&
        hasProtectedValues(original) &&
        (duplicate || changedDefinition(original, node))
      )
        changed(path);
      const config = restoreRecord(
        original?.config,
        maskedSetting,
        node.config,
        `${path}.config`,
      );
      const inputMappings = restoreRecord(
        original?.inputMappings,
        maskedMapping,
        node.inputMappings,
        `${path}.inputMappings`,
      );
      const connectionRefs = restoreRecord(
        original?.connectionRefs,
        maskedConnection,
        node.connectionRefs,
        `${path}.connectionRefs`,
      );
      if (
        !hasEntries(original?.connectionRefs) &&
        hasEntries(node.connectionRefs)
      )
        issues.push({
          path: `${path}.connectionRefs`,
          code: 'connection_requires_user',
          message: 'Select the connection in the editor.',
        });
      const previousBody = original?.structured?.body;
      const structured = node.structured;
      if (
        structured === undefined &&
        previousBody?.nodes.some(hasProtectedValues)
      )
        changed(`${path}.structured`);
      return {
        ...node,
        config,
        inputMappings,
        connectionRefs,
        ...(structured === undefined
          ? {}
          : {
              structured: {
                ...structured,
                body: {
                  ...structured.body,
                  nodes: restoreNodes(
                    previousBody?.nodes ?? [],
                    structured.body.nodes,
                    `${path}.structured.body`,
                  ),
                },
              },
            }),
      };
    });
  }

  function restoreRecord<Value>(
    original: Readonly<Record<string, Value>> | undefined,
    marker: Value,
    next: Readonly<Record<string, Value>>,
    path: string,
  ) {
    if (original === undefined || !hasEntries(original)) return next;
    if (canonicalJson(next) !== canonicalJson(maskRecord(original, marker)))
      changed(path);
    return original;
  }
}

function hasProtectedValues(node: WorkflowNode): boolean {
  return (
    [node.config, node.inputMappings, node.connectionRefs].some(
      (record) => Object.keys(record).length > 0,
    ) ||
    (node.structured?.body.nodes.some(hasProtectedValues) ?? false)
  );
}

function maskRecord<Value>(
  record: object,
  value: Value,
): Record<string, Value> {
  return hasEntries(record) ? { [protectedField]: value } : {};
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
