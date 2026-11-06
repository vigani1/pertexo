import { normalizedJson } from '../values/json/canonical.js';
import type { WorkflowNode, ValueSource } from './workflow-graph.schemas.js';

/** Mapping order and JSON-valued settings are observable by step execution. */
export function workflowExecutionValues(
  node: Pick<WorkflowNode, 'config' | 'inputMappings'>,
) {
  return {
    config: Object.fromEntries(
      Object.entries(node.config).map(([key, value]) => [
        key,
        normalizedJson(value),
      ]),
    ),
    inputMappings: Object.entries(node.inputMappings).map(([key, source]) => [
      key,
      valueSourceExecutionIdentity(source),
    ]),
  };
}

/** JSON object order is data in literal values, including callable results. */
export function valueSourceExecutionIdentity(source: ValueSource) {
  return source.kind === 'literal'
    ? { ...source, value: normalizedJson(source.value) }
    : source;
}
