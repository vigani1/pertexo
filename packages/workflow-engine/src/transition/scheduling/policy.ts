import {
  isRecord,
  pendingTaskOutputPorts,
  workflowControlOutputKind,
} from '@pertexo/workflow-model';
import type { ExecutionFailureRoute } from '../../compilation/foundation.js';

import type { BranchScopePart, IterationScopePart } from '../../types.js';
import type { SideEffectClass } from '../../types.js';
import { isCoreParallelDefinition } from '../../core-definition-identities.js';

/** Private execution projection derived only from a verified executable. */
export interface SchedulerState {
  readonly failureRoutes?: readonly ExecutionFailureRoute[];
  readonly deriveReadiness: boolean;
  readonly nodes: readonly {
    readonly id: string;
    readonly definition?: { readonly key: string; readonly version: number };
    readonly config?: Readonly<Record<string, unknown>>;
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

export function configuredBranchOutputPorts(
  node: Readonly<{
    definition?: Readonly<{ key: string; version: number }>;
    config?: Readonly<Record<string, unknown>>;
  }>,
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
  if (node.definition?.key !== 'core.switch' || node.definition.version !== 1)
    return undefined;
  if (node.config === undefined) return undefined;
  const cases = node.config.cases;
  if (!Array.isArray(cases)) return undefined;
  const ports = cases.map((item): unknown =>
    isRecord(item) ? item.id : undefined,
  );
  if (
    ports.some(
      (port) =>
        typeof port !== 'string' || !/^case-(?:0[1-9]|1[0-6])$/u.test(port),
    ) ||
    new Set(ports).size !== ports.length
  )
    return undefined;
  return [...(ports as string[]), 'default'];
}

export function configuredParallelOutputPorts(
  node: Readonly<{
    definition?: Readonly<{ key: string; version: number }>;
    config?: Readonly<Record<string, unknown>>;
  }>,
): readonly string[] | undefined {
  if (!isCoreParallelDefinition(node.definition) || node.config === undefined)
    return undefined;
  const branches = node.config.branches;
  if (!Array.isArray(branches)) return undefined;
  const ports = branches.map((item): unknown =>
    isRecord(item) ? item.id : undefined,
  );
  const invalidBranches =
    ports.length < 2 ||
    ports.some(
      (port) =>
        typeof port !== 'string' || !/^branch-(?:0[1-9]|1[0-6])$/u.test(port),
    ) ||
    new Set(ports).size !== ports.length;
  if (invalidBranches) return undefined;
  return ports as string[];
}

export function configuredParallelMaxConcurrency(
  node: Parameters<typeof configuredParallelOutputPorts>[0],
): number | undefined {
  const ports = configuredParallelOutputPorts(node);
  if (ports === undefined) return undefined;
  const value = node.config?.maxConcurrency;
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= ports.length
    ? value
    : undefined;
}

export function configuredScopedOutputPorts(
  node: Parameters<typeof configuredBranchOutputPorts>[0],
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
