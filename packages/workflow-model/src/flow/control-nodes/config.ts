import type { z } from 'zod';

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
        : invalid('Switch', parsed.error);
    }
    case 'core.parallel': {
      const parsed = parallelConfigSchema.safeParse(node.config);
      return parsed.success
        ? { kind: 'valid', value: { kind: 'parallel', config: parsed.data } }
        : invalid('Parallel', parsed.error);
    }
    case 'core.merge': {
      const parsed = mergeConfigSchema.safeParse(node.config);
      return parsed.success
        ? { kind: 'valid', value: { kind: 'merge', config: parsed.data } }
        : invalid('Merge', parsed.error);
    }
    default:
      return { kind: 'none' };
  }
}

function invalid(
  label: string,
  error: z.ZodError,
): ControlNodeConfigInspection {
  const issue = error.issues[0];
  const path = issue?.path.join('.') ?? '';
  return {
    kind: 'invalid',
    message: `${label} config is invalid${path === '' ? '' : ` at ${path}`}: ${issue?.message ?? 'unknown issue'}`,
  };
}
