import { parseJsonPath, isRecord } from '@pertexo/workflow-model';
import type { WorkflowGraphContract } from '@pertexo/contracts';
import { walkLevels, indexGraph, type GraphLevel } from '../../graph/scopes';
import { stepTitle } from '../../graph/adapter';

type Source = WorkflowGraphContract['nodes'][number]['inputMappings'][string];
export type ColumnNameReference = Readonly<{
  nodeId: string | null;
  step: string;
  input: string;
  detail: string;
}>;

/** Include bodies reached later and consumers after a containing loop, without walking back into earlier body steps. */
function laterSteps(graph: GraphLevel, nodeId: string): ReadonlySet<string> {
  const next = new Map<string, Set<string>>();
  const link = (from: string, to: string) => {
    const targets = next.get(from) ?? new Set<string>();
    targets.add(to);
    next.set(from, targets);
  };
  walkLevels(graph, (level) => {
    for (const edge of level.edges)
      link(edge.source.nodeId, edge.target.nodeId);
    for (const node of level.nodes) {
      if (node.structured === undefined) continue;
      const following = level.edges
        .filter((edge) => edge.source.nodeId === node.id)
        .map((edge) => edge.target.nodeId);
      walkLevels(node.structured.body, (body) => {
        for (const child of body.nodes) {
          link(node.id, child.id);
          for (const target of following) link(child.id, target);
        }
      });
    }
  });
  const seen = new Set<string>([nodeId]);
  const queue = [nodeId];
  for (const id of queue)
    for (const target of next.get(id) ?? []) {
      if (seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  seen.delete(nodeId);
  return seen;
}
function mentionsColumn(path: string, aliases: ReadonlySet<string>): boolean {
  const parts = parseJsonPath(path);
  return (
    parts?.some((part, index) => {
      const name = parts[index + 1];
      return part === 'values' && typeof name === 'string' && aliases.has(name);
    }) ?? false
  );
}
function tableFieldPath(path: string, aliases: ReadonlySet<string>): boolean {
  const parts = parseJsonPath(path);
  const alias = parts?.[3];
  return (
    parts?.[0] === 'rows' &&
    typeof parts[1] === 'number' &&
    parts[2] === 'values' &&
    typeof alias === 'string' &&
    aliases.has(alias)
  );
}
function receivesColumns(path: string): boolean {
  const parts = parseJsonPath(path);
  return (
    parts === undefined ||
    parts.length === 0 ||
    (parts[0] === 'rows' &&
      (parts.length === 1 ||
        (typeof parts[1] === 'number' &&
          (parts.length === 2 ||
            (parts.length === 3 && parts[2] === 'values')))))
  );
}
function embeddedPaths(value: unknown, aliases: ReadonlySet<string>): string[] {
  if (typeof value === 'string')
    return mentionsColumn(value, aliases) ? [value] : [];
  if (Array.isArray(value))
    return value.flatMap((entry: unknown) => embeddedPaths(entry, aliases));
  if (isRecord(value))
    return Object.values(value).flatMap((entry) =>
      embeddedPaths(entry, aliases),
    );
  return [];
}

/** Programs can compute paths dynamically. Report them for review, never pretend a text scan proves them safe. */
export function tableColumnReferences(
  graph: WorkflowGraphContract,
  nodeId: string,
  oldNames: readonly string[],
): readonly ColumnNameReference[] {
  const aliases = new Set(oldNames);
  const later = laterSteps(graph, nodeId);
  const result: ColumnNameReference[] = [];
  function inspect({
    source,
    consumerId,
    step,
    input,
    downstream,
  }: Readonly<{
    source: Source;
    consumerId: string | null;
    step: string;
    input: string;
    downstream: boolean;
  }>) {
    if (source.kind === 'node_output' && source.nodeId === nodeId) {
      if (tableFieldPath(source.path, aliases))
        result.push({
          nodeId: consumerId,
          step,
          input,
          detail: `Old output path: ${source.path}`,
        });
      else if (receivesColumns(source.path))
        result.push({
          nodeId: consumerId,
          step,
          input,
          detail: `Receives fields whose names change: ${source.path}`,
        });
      return;
    }
    if (!downstream) return;
    switch (source.kind) {
      case 'expression':
        result.push({
          nodeId: consumerId,
          step,
          input,
          detail: 'Expression: review computed output paths manually.',
        });
        break;
      case 'literal':
        for (const path of new Set(embeddedPaths(source.value, aliases)))
          result.push({
            nodeId: consumerId,
            step,
            input,
            detail: `Embedded path: ${path} — check which data it reads.`,
          });
        break;
      case 'node_output':
      case 'structured_input':
        if (mentionsColumn(source.path, aliases))
          result.push({
            nodeId: consumerId,
            step,
            input,
            detail: `Later path: ${source.path} — check whether it carries these fields.`,
          });
        break;
      case 'run_input':
      case 'workspace_variable':
      case 'node_failure':
        break;
    }
  }
  for (const { item: node } of indexGraph(graph).nodes.values()) {
    if (node.id === nodeId) continue;
    const downstream = later.has(node.id);
    for (const [input, source] of Object.entries(node.inputMappings))
      inspect({
        source,
        consumerId: node.id,
        step: stepTitle(node),
        input,
        downstream,
      });
    if (!downstream) continue;
    for (const path of new Set(embeddedPaths(node.config, aliases)))
      result.push({
        nodeId: node.id,
        step: stepTitle(node),
        input: 'Setup',
        detail: `Embedded path: ${path} — check which data it reads.`,
      });
    if (node.definition.key === 'core.code')
      result.push({
        nodeId: node.id,
        step: stepTitle(node),
        input: 'Code',
        detail: 'Code: review computed output paths manually.',
      });
  }
  if (graph.callable !== undefined)
    inspect({
      source: graph.callable.result,
      consumerId: null,
      step: 'Workflow result',
      input: 'result',
      downstream: true,
    });
  return result;
}
