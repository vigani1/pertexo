import type { WorkflowGraph, WorkflowNode } from '@pertexo/workflow-model';
import {
  fieldMask,
  maskedConnection,
  maskedMapping,
  maskedSetting,
  type DisclosureLookup,
  type Fields,
} from './masked-fields.js';

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
