import { approvalConfigSchema } from '../../flow/pending-tasks/approval.js';
import { formConfigSchema } from '../../triggers/forms/fields.js';
import { inputRequestConfigSchema } from '../../flow/pending-tasks/input-request.js';
import { isRecord } from '../../values/json/object.js';
import type { WorkflowNode } from '../../graph/workflow-graph.schemas.js';
import {
  propertyDefaults,
  readSchemaUnion,
  withUnionChoice,
} from './schema-union.js';

type NodeConfig = WorkflowNode['config'];
type SetupDefinition = Readonly<{
  definition: WorkflowNode['definition'];
  configSchema: NodeConfig;
}>;
type LevelNode = Pick<WorkflowNode, 'id' | 'definition'>;

/**
 * A new step's setup, from its catalog schema: the schema's own `default`
 * when it gives a whole starting setup (a union names the shape it starts
 * in), else the first union shape or the standalone shape, with its
 * property defaults. Human tasks start from their parsed
 * empty form, and a Merge waits for every branch and joins the Parallel on
 * its level when there's exactly one to join; a schema can't say that.
 * Supplied values take precedence, and a supplied variant uses its own fields.
 */
export function startingConfig(
  definition: SetupDefinition,
  levelNodes: readonly LevelNode[],
  supplied?: NodeConfig,
): NodeConfig {
  const defaults = startingDefaults(definition, levelNodes);
  if (supplied === undefined) return defaults;
  const union = readSchemaUnion(definition.configSchema);
  const choice = union === undefined ? undefined : supplied[union.key];
  const setup =
    union !== undefined &&
    typeof choice === 'string' &&
    choice !== defaults[union.key]
      ? (withUnionChoice(union, defaults, choice) ?? defaults)
      : defaults;
  return { ...setup, ...supplied };
}

function startingDefaults(
  definition: SetupDefinition,
  levelNodes: readonly LevelNode[],
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
