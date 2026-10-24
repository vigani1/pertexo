import { formConfigSchema, workflowGraphSchema } from '@pertexo/workflow-model';
import { FormUnavailableError } from './errors.js';

export function readFormDefinition(graph_json: unknown) {
  const graph = workflowGraphSchema.parse(graph_json);
  const node = graph.nodes.find(
    (node) =>
      node.definition.key === 'core.form' &&
      node.definition.version === 1 &&
      !(node.disabled ?? false),
  );
  if (node === undefined) throw new FormUnavailableError();
  return { nodeId: node.id, form: formConfigSchema.parse(node.config) };
}
