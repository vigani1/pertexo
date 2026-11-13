import type { WorkflowNode } from './scopes';
import { stepTitle } from './step-title';

/**
 * A For each step's body in summary (ADR 020): the steps that run once per
 * item, the body's `item`/`ordinal` inputs and `result` output, and the
 * bounds on items and concurrency. The graph itself is untouched.
 */
export type LoopSummary = Readonly<{
  maxIterations: number;
  maxConcurrency: number;
  /** The body's steps, in stored order. */
  steps: readonly Readonly<{ id: string; title: string }>[];
  inputs: readonly string[];
  outputs: readonly string[];
}>;

export function loopSummary(
  node: Pick<WorkflowNode, 'structured'>,
): LoopSummary | null {
  const structured = node.structured;
  if (structured === undefined) return null;
  return {
    maxIterations: structured.maxIterations,
    maxConcurrency: structured.maxConcurrency,
    steps: structured.body.nodes.map((step) => ({
      id: step.id,
      title: stepTitle(step),
    })),
    inputs: structured.body.inputPorts,
    outputs: structured.body.outputPorts,
  };
}
