import {
  failure,
  type WorkflowGraphAdmissionFailure,
  type WorkflowGraphAdmissionLimits,
} from './admission-contract.js';

function valueDepthFailure(
  value: unknown,
  path: string,
  maximum: number,
): WorkflowGraphAdmissionFailure | undefined {
  const stack: { value: unknown; path: string; depth: number }[] = [
    { value, path, depth: 1 },
  ];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    if (current.depth > maximum)
      return failure(
        'json_value_depth',
        current.path,
        `JSON value depth exceeds ${String(maximum)}`,
      );
    if (current.value === null || typeof current.value !== 'object') continue;
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1)
        stack.push({
          value: current.value[index],
          path: `${current.path}[${String(index)}]`,
          depth: current.depth + 1,
        });
    } else {
      for (const key of Object.keys(current.value))
        stack.push({
          value: (current.value as Record<string, unknown>)[key],
          path: `${current.path}.${key}`,
          depth: current.depth + 1,
        });
    }
  }
  return undefined;
}

export function inspectGraphFacts(
  snapshot: unknown,
  limits: WorkflowGraphAdmissionLimits,
): WorkflowGraphAdmissionFailure | undefined {
  const graphs: { value: unknown; path: string; depth: number }[] = [
    { value: snapshot, path: '$', depth: 0 },
  ];
  while (graphs.length > 0) {
    const current = graphs.pop();
    if (current === undefined || current.value === null) continue;
    if (current.depth > limits.structuredDepth)
      return failure(
        'structured_depth',
        current.path,
        `structured graph depth exceeds ${String(limits.structuredDepth)}`,
      );
    if (typeof current.value !== 'object' || Array.isArray(current.value))
      continue;
    const graph = current.value as Record<string, unknown>;
    const callable = graph.callable;
    if (
      callable !== null &&
      typeof callable === 'object' &&
      !Array.isArray(callable)
    ) {
      const result = (callable as Record<string, unknown>).result;
      if (
        result !== null &&
        typeof result === 'object' &&
        !Array.isArray(result) &&
        (result as Record<string, unknown>).kind === 'literal'
      ) {
        const issue = valueDepthFailure(
          (result as Record<string, unknown>).value,
          `${current.path}.callable.result.value`,
          limits.jsonValueDepth,
        );
        if (issue !== undefined) return issue;
      }
    }
    const graphNodes: unknown = graph.nodes;
    if (!Array.isArray(graphNodes)) continue;
    for (let index = 0; index < graphNodes.length; index += 1) {
      const node: unknown = graphNodes[index];
      const nodePath = `${current.path}.nodes[${String(index)}]`;
      if (node === null || typeof node !== 'object' || Array.isArray(node))
        continue;
      const record = node as Record<string, unknown>;
      if (record.config !== undefined) {
        const issue = valueDepthFailure(
          record.config,
          `${nodePath}.config`,
          limits.jsonValueDepth,
        );
        if (issue !== undefined) return issue;
      }
      const mappings = record.inputMappings;
      if (
        mappings !== null &&
        typeof mappings === 'object' &&
        !Array.isArray(mappings)
      )
        for (const key of Object.keys(mappings)) {
          const mappingPath = `${nodePath}.inputMappings.${key}`;
          const mapping = (mappings as Record<string, unknown>)[key];
          if (
            mapping !== null &&
            typeof mapping === 'object' &&
            !Array.isArray(mapping) &&
            (mapping as Record<string, unknown>).kind === 'literal'
          ) {
            const issue = valueDepthFailure(
              (mapping as Record<string, unknown>).value,
              `${mappingPath}.value`,
              limits.jsonValueDepth,
            );
            if (issue !== undefined) return issue;
          }
        }
      const structured = record.structured;
      if (
        structured !== null &&
        typeof structured === 'object' &&
        !Array.isArray(structured)
      )
        graphs.push({
          value: (structured as Record<string, unknown>).body,
          path: `${nodePath}.structured.body`,
          depth: current.depth + 1,
        });
    }
  }
  return undefined;
}
