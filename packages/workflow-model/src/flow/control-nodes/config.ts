import { mergeConfigSchema, type MergeConfig } from './merge.js';
import { parallelConfigSchema, type ParallelConfig } from './parallel.js';
import { switchConfigSchema, type SwitchConfig } from './switch.js';

/** The setup of a step whose config decides its output ports or its join. */
export type ControlNodeConfig =
  | Readonly<{ kind: 'switch'; config: SwitchConfig }>
  | Readonly<{ kind: 'parallel'; config: ParallelConfig }>
  | Readonly<{ kind: 'merge'; config: MergeConfig }>;

export type ControlNodeConfigInspection =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'valid'; value: ControlNodeConfig }>
  | Readonly<{ kind: 'invalid'; message: string }>;

/**
 * Reads a Switch, Parallel or Merge setup with the same schemas its node
 * definition publishes, so routing and joins can't accept a different shape.
 */
export function inspectControlNodeConfig(
  node: Readonly<{
    definition: Readonly<{ key: string; version: number }>;
    config: unknown;
  }>,
): ControlNodeConfigInspection {
  if (node.definition.version !== 1) return { kind: 'none' };
  switch (node.definition.key) {
    case 'core.switch': {
      const parsed = switchConfigSchema.safeParse(node.config);
      return parsed.success
        ? { kind: 'valid', value: { kind: 'switch', config: parsed.data } }
        : { kind: 'invalid', message: 'Switch config is invalid' };
    }
    case 'core.parallel': {
      const parsed = parallelConfigSchema.safeParse(node.config);
      return parsed.success
        ? { kind: 'valid', value: { kind: 'parallel', config: parsed.data } }
        : { kind: 'invalid', message: 'Parallel config is invalid' };
    }
    case 'core.merge': {
      const parsed = mergeConfigSchema.safeParse(node.config);
      return parsed.success
        ? { kind: 'valid', value: { kind: 'merge', config: parsed.data } }
        : { kind: 'invalid', message: 'Merge config is invalid' };
    }
    default:
      return { kind: 'none' };
  }
}
