import {
  approvalConfigSchema,
  formConfigSchema,
  inputRequestConfigSchema,
  isRecord,
} from '@pertexo/workflow-model';
import type { NodeDefinitionCatalogItem } from '@pertexo/contracts';
import { readSchemaUnion, withUnionChoice } from '../inspector/schema-union';
import { propertyDefaults } from '../inspector/draft';
import type { WorkflowNode } from './scopes';

type NodeConfig = WorkflowNode['config'];

/**
 * A new step's setup, from its catalog schema: the schema's own `default`
 * when it gives a whole starting setup (a union names the shape it starts
 * in), else the first union shape or the standalone shape, with its
 * property defaults. Human tasks start from their parsed
 * empty form, and a Merge waits for every branch and joins the Parallel on
 * its level when there's exactly one to join; a schema can't say that.
 */
export function startingConfig(
  definition: Pick<NodeDefinitionCatalogItem, 'definition' | 'configSchema'>,
  levelNodes: readonly WorkflowNode[],
): NodeConfig {
  const { key } = definition.definition;
  if (key === 'core.form') return formConfigSchema.parse({});
  if (key === 'core.request_input') return inputRequestConfigSchema.parse({});
  if (key === 'core.approval') return approvalConfigSchema.parse({});
  if (key === 'core.merge') {
    const parallels = levelNodes.filter(
      (node) => node.definition.key === 'core.parallel',
    );
    const [only] = parallels;
    return {
      policy: { kind: 'all' },
      ...(parallels.length === 1 && only !== undefined
        ? { parallelNodeId: only.id }
        : {}),
    };
  }
  const whole = definition.configSchema.default;
  if (isRecord(whole)) return structuredClone(whole);
  const union = readSchemaUnion(definition.configSchema);
  const first = union?.choices[0];
  if (union !== undefined && first !== undefined)
    return withUnionChoice(union, {}, first.value) ?? {};
  return propertyDefaults(definition.configSchema);
}
