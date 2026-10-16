import { formConfigSchema, workflowGraphSchema } from '@pertexo/workflow-model';
import { FormUnavailableError } from './contract.js';

export function readFormDefinition(graph_json: unknown) {
  const graph = workflowGraphSchema.parse(graph_json);
  const node = graph.nodes.find(
    (node) =>
      node.definition.key === 'core.form' &&
      node.definition.version === 1 &&
      node.disabled !== true,
  );
  if (node === undefined) throw new FormUnavailableError();
  return { nodeId: node.id, form: formConfigSchema.parse(node.config) };
}
