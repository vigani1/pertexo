import {
  pendingTaskOutputPorts,
  workflowControlOutputKind,
  type ControlNodeConfig,
} from '@pertexo/workflow-model';
import type { ExecutionFailureRoute } from '../../compilation/foundation.js';

import type { BranchScopePart, IterationScopePart } from '../../types.js';
import type { SideEffectClass } from '../../types.js';

/** Private execution projection derived only from a verified executable. */
export interface SchedulerState {
  readonly failureRoutes?: readonly ExecutionFailureRoute[];
  readonly deriveReadiness: boolean;
  readonly nodes: readonly {
    readonly id: string;
    readonly definition?: { readonly key: string; readonly version: number };
    readonly config?: Readonly<Record<string, unknown>>;
    readonly control?: ControlNodeConfig;
    readonly disabled?: boolean;
    readonly sideEffectClass: SideEffectClass;
  }[];
  readonly edges: readonly {
    readonly source: { readonly nodeId: string; readonly port: string };
    readonly target: { readonly nodeId: string; readonly port: string };
  }[];
  readonly structuredBodies?: readonly {
    readonly loopNodeId: string;
    readonly nodes: SchedulerState['nodes'];
    readonly edges: SchedulerState['edges'];
  }[];
}

type ControlledNode = Readonly<{
  definition?: Readonly<{ key: string; version: number }>;
  config?: Readonly<Record<string, unknown>>;
  control?: ControlNodeConfig;
}>;

export function configuredBranchOutputPorts(
  node: ControlledNode,
): readonly string[] | undefined {
  // A Request input routes by branch only once it has a Timed out path.
  const taskPorts = pendingTaskOutputPorts(node);
  if (taskPorts !== undefined)
    return taskPorts.length > 1 ? taskPorts : undefined;
  if (workflowControlOutputKind(node.definition) !== 'branch') return undefined;
  if (
    node.definition?.key === 'core.condition' &&
    node.definition.version === 1
  )
    return ['false', 'true'];
  if (node.control?.kind !== 'switch') return undefined;
  return [...node.control.config.cases.map(({ id }) => id), 'default'];
}

export function configuredParallelOutputPorts(
  node: ControlledNode,
): readonly string[] | undefined {
  return node.control?.kind === 'parallel'
    ? node.control.config.branches.map(({ id }) => id)
    : undefined;
}

export function configuredParallelMaxConcurrency(
  node: ControlledNode,
): number | undefined {
  return node.control?.kind === 'parallel'
    ? node.control.config.maxConcurrency
    : undefined;
}

export function configuredPairedParallelId(
  node: ControlledNode,
): string | undefined {
  return node.control?.kind === 'merge'
    ? node.control.config.parallelNodeId
    : undefined;
}

export function configuredScopedOutputPorts(
  node: ControlledNode,
): readonly string[] | undefined {
  return (
    configuredBranchOutputPorts(node) ?? configuredParallelOutputPorts(node)
  );
}

export interface ReadyNodeDecision {
  readonly invocationKey: string;
  readonly nodeId: string;
  readonly disposition: 'ready' | 'skipped';
  readonly branchPath?: readonly BranchScopePart[];
  readonly iterationPath?: readonly IterationScopePart[];
}
