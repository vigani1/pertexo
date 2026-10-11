import type { WorkflowGraph } from '../graph/contract.js';
import {
  isWorkflowCallDefinition,
  workflowCallConfigSchema,
} from './invocation.js';

export interface WorkflowCallPin {
  readonly workflowId: string;
  readonly workflowVersionId: string;
  readonly executableChecksum: string;
}

export interface CallableVersionSummary extends WorkflowCallPin {
  readonly workspaceId: string;
  /** Includes each local Call invocation, with For Each products applied. */
  readonly expandedInvocations: number;
  readonly calls: readonly Readonly<{
    nodeId: string;
    pin: WorkflowCallPin;
    multiplicity: number;
  }>[];
}

export class WorkflowCallDependencyError extends TypeError {
  public override readonly name = 'WorkflowCallDependencyError';
  public constructor(
    readonly code: 'workspace' | 'pin' | 'cycle' | 'expansion',
  ) {
    super('Workflow call dependencies do not satisfy the publication contract');
  }
}

/** Validated immutable summaries are shared; every call site's weight still counts. */
export async function validateCallDependencyClosure(
  root: CallableVersionSummary,
  resolve: (pin: WorkflowCallPin) => Promise<CallableVersionSummary>,
  maximumInvocations: number,
): Promise<number> {
  const summaries = new Map<string, CallableVersionSummary>([
    [root.workflowVersionId, root],
  ]);
  const closures = new Map<
    string,
    Readonly<{ count: number; workflows: ReadonlySet<string> }>
  >();
  const ancestors = new Set<string>();
  const visit = async (
    summary: CallableVersionSummary,
  ): Promise<Readonly<{ count: number; workflows: ReadonlySet<string> }>> => {
    if (summary.workspaceId !== root.workspaceId)
      throw new WorkflowCallDependencyError('workspace');
    if (ancestors.has(summary.workflowId))
      throw new WorkflowCallDependencyError('cycle');
    const cached = closures.get(summary.workflowVersionId);
    if (cached !== undefined) {
      if ([...cached.workflows].some((workflowId) => ancestors.has(workflowId)))
        throw new WorkflowCallDependencyError('cycle');
      return cached;
    }
    ancestors.add(summary.workflowId);
    let count = summary.expandedInvocations;
    if (count > maximumInvocations)
      throw new WorkflowCallDependencyError('expansion');
    const workflows = new Set([summary.workflowId]);
    for (const { pin, multiplicity } of summary.calls) {
      let target = summaries.get(pin.workflowVersionId);
      if (target === undefined) {
        target = await resolve(pin);
        summaries.set(pin.workflowVersionId, target);
      }
      if (
        target.workflowId !== pin.workflowId ||
        target.workflowVersionId !== pin.workflowVersionId ||
        target.executableChecksum !== pin.executableChecksum
      )
        throw new WorkflowCallDependencyError('pin');
      const child = await visit(target);
      count += multiplicity * child.count;
      if (count > maximumInvocations)
        throw new WorkflowCallDependencyError('expansion');
      for (const workflowId of child.workflows) workflows.add(workflowId);
    }
    ancestors.delete(summary.workflowId);
    const closure = { count, workflows };
    closures.set(summary.workflowVersionId, closure);
    return closure;
  };
  return (await visit(root)).count;
}

/** Graph validation supplies the local count; each structured site retains its weight. */
export function summarizeWorkflowCalls(
  identity: WorkflowCallPin & Readonly<{ workspaceId: string }>,
  graph: WorkflowGraph,
  expandedInvocations: number,
): CallableVersionSummary {
  const calls: CallableVersionSummary['calls'][number][] = [];
  const visit = (current: WorkflowGraph, multiplicity: number): void => {
    for (const node of current.nodes) {
      if (isWorkflowCallDefinition(node.definition))
        calls.push({
          nodeId: node.id,
          pin: workflowCallConfigSchema.parse(node.config).target,
          multiplicity,
        });
      if (node.structured !== undefined)
        visit(
          node.structured.body,
          multiplicity * node.structured.maxIterations,
        );
    }
  };
  visit(graph, 1);
  return { ...identity, expandedInvocations, calls };
}
