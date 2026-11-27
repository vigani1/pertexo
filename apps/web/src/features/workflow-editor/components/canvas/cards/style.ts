import {
  describeStep,
  familyWord,
  type StepPresentation,
} from '@/features/catalog/public';
import { cn } from '@/lib/class-names';
import type { WorkflowFlowNode } from '../../../model/graph/adapter';
import { formatCount } from '@/lib/format/count';

// Looks and words every step card shares, whatever its shape.

export const handleClass =
  '!size-2.5 !border-[1.5px] !border-primary !bg-background !shadow-selection';

/**
 * A step's presentation, the title on its card and the type under it, with
 * a few words from its setup when there are some ("Validate · 6 rules").
 */
export function cardIdentity(data: WorkflowFlowNode['data']): Readonly<{
  step: StepPresentation;
  title: string;
  type: string;
}> {
  const step = describeStep(
    { key: data.definitionKey, version: data.definitionVersion },
    data.family === 'unknown' ? undefined : data.family,
    data.metadata,
  );
  const kind = data.label === undefined ? familyWord(step.family) : step.name;
  return {
    step,
    title: data.label ?? step.name,
    type: data.summary === undefined ? kind : `${kind} · ${data.summary}`,
  };
}

/**
 * What a step card is called: its title, type and issues, and for a For
 * each the body's unfinished parts. Only the canvas wrapper that takes
 * keyboard focus carries it, so a screen reader says it once.
 */
export function stepCardLabel(
  node: Pick<WorkflowFlowNode, 'type' | 'data'>,
): string {
  const { title, type } = cardIdentity(node.data);
  const issues = node.data.issueCount;
  const label =
    issues > 0
      ? `${title}, ${type}, ${formatCount(issues, 'issue')}`
      : `${title}, ${type}`;
  const bodyIssues = node.data.body?.issues.length ?? 0;
  return node.type === 'forEach' && bodyIssues > 0
    ? `${label}, body needs ${formatCount(bodyIssues, 'fix', 'fixes')}`
    : label;
}

// React Flow clears the outline on the focused node, so its card wears it.
const NODE_FOCUS_RING = String.raw`in-[.react-flow\_\_node:focus-visible]:outline-2 in-[.react-flow\_\_node:focus-visible]:outline-offset-2 in-[.react-flow\_\_node:focus-visible]:outline-ring`;

export function cardClassName(
  state: Readonly<{
    hasIssues: boolean;
    selected: boolean;
    disabled: boolean;
    /** The last run is working in this step: it breathes. */
    running?: boolean;
    /** The last run finished without reaching this step. */
    passedBy?: boolean;
  }>,
  className?: string,
): string {
  return cn(
    'relative w-56 rounded-lg border border-surface-ink/9 border-t-surface-ink/15 bg-card px-3 py-2.5 text-card-foreground shadow-node transition-[border-color,box-shadow,opacity] duration-150 motion-reduce:transition-none',
    NODE_FOCUS_RING,
    state.hasIssues && 'border-destructive/50 shadow-node-issue',
    state.selected && 'border-action-line shadow-selection',
    (state.running ?? false) &&
      'border-live-line node-live motion-loop:animate-node-live',
    (state.disabled || (state.passedBy ?? false)) && 'opacity-55',
    className,
  );
}
