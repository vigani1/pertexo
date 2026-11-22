import {
  classifyCategoriesSchema,
  isClassifyDefinition,
  type ClassifyCategory,
} from './classify.js';
import { isRecord } from '../../values/json/object.js';
import {
  isCoreMergeDefinition,
  isCoreSwitchDefinition,
} from './control-node-definitions.js';
import { mergeConfigSchema, type MergeConfig } from './merge.js';
import { parallelConfigSchema, type ParallelConfig } from './parallel.js';
import { switchConfigSchema, type SwitchConfig } from './switch.js';

/** The setup of a step whose config decides its output ports or its join. */
export type ControlNodeConfig =
  | Readonly<{ kind: 'classify'; categories: readonly ClassifyCategory[] }>
  | Readonly<{ kind: 'switch'; config: SwitchConfig }>
  | Readonly<{ kind: 'parallel'; config: ParallelConfig }>
  | Readonly<{ kind: 'merge'; config: MergeConfig }>;

export type ControlNodeConfigInspection =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'valid'; value: ControlNodeConfig }>
  | Readonly<{ kind: 'invalid'; message: string }>;

/**
 * Reads configured branch and join settings with the same schemas its node
 * definition publishes, so routing and joins can't accept a different shape.
 */
export function inspectControlNodeConfig(
  node: Readonly<{
    definition: Readonly<{ key: string; version: number }>;
    config: unknown;
  }>,
): ControlNodeConfigInspection {
  if (isClassifyDefinition(node.definition)) {
    const parsed = classifyCategoriesSchema.safeParse(
      isRecord(node.config) ? node.config.categories : undefined,
    );
    return parsed.success
      ? { kind: 'valid', value: { kind: 'classify', categories: parsed.data } }
      : { kind: 'invalid', message: 'Classify categories are invalid' };
  }
  if (isCoreSwitchDefinition(node.definition)) {
    const parsed = switchConfigSchema.safeParse(node.config);
    return parsed.success
      ? { kind: 'valid', value: { kind: 'switch', config: parsed.data } }
      : { kind: 'invalid', message: 'Switch config is invalid' };
  }
  if (isCoreMergeDefinition(node.definition)) {
    const parsed = mergeConfigSchema.safeParse(node.config);
    return parsed.success
      ? { kind: 'valid', value: { kind: 'merge', config: parsed.data } }
      : { kind: 'invalid', message: 'Merge config is invalid' };
  }
  if (
    node.definition.key === 'core.parallel' &&
    node.definition.version === 1
  ) {
    const parsed = parallelConfigSchema.safeParse(node.config);
    return parsed.success
      ? { kind: 'valid', value: { kind: 'parallel', config: parsed.data } }
      : { kind: 'invalid', message: 'Parallel config is invalid' };
  }
  return { kind: 'none' };
}
