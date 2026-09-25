import {
  describeStep,
  familyWord,
  type StepPresentation,
} from '@/features/catalog/presentation.public';
import { cn } from '@/lib/utils';
import type { WorkflowFlowNode } from '../../model/graph-adapter';

// Looks and words every step card shares, whatever its shape.

export const handleClass =
  '!size-2.5 !border-[1.5px] !border-primary !bg-background !shadow-[0_0_8px_color-mix(in_srgb,var(--primary)_50%,transparent)]';

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
    data.definitionKey,
    data.family === 'unknown' ? undefined : data.family,
  );
  const kind = data.label === undefined ? familyWord(step.family) : step.name;
  return {
    step,
    title: data.label ?? step.name,
    type: data.summary === undefined ? kind : `${kind} · ${data.summary}`,
  };
}

export function nodeLabel(
  title: string,
  type: string,
  issueCount: number,
): string {
  return issueCount > 0
    ? `${title}, ${type}, ${issueCount === 1 ? '1 issue' : `${String(issueCount)} issues`}`
    : `${title}, ${type}`;
}

export function cardClassName(
  state: Readonly<{ hasIssues: boolean; selected: boolean; disabled: boolean }>,
  className?: string,
): string {
  return cn(
    'relative w-56 rounded-lg border border-white/9 border-t-white/15 bg-[linear-gradient(160deg,rgb(255_255_255/5.5%),rgb(255_255_255/1.5%)),var(--card)] px-3 py-2.5 text-card-foreground shadow-[0_18px_44px_-18px_rgb(0_0_0/90%)] transition-[border-color,box-shadow,opacity] duration-150 motion-reduce:transition-none',
    state.hasIssues &&
      'border-destructive/50 shadow-[0_0_0_1px_color-mix(in_srgb,var(--destructive)_20%,transparent),0_0_26px_-6px_color-mix(in_srgb,var(--destructive)_45%,transparent)]',
    state.selected &&
      'border-primary/55 shadow-[0_0_0_1px_color-mix(in_srgb,var(--primary)_25%,transparent),0_0_30px_-4px_color-mix(in_srgb,var(--primary)_35%,transparent)]',
    state.selected &&
      'after:pointer-events-none after:absolute after:inset-[-1px] after:rounded-[inherit] after:border after:border-transparent after:bg-[linear-gradient(90deg,transparent,var(--primary),transparent)_border-box] after:bg-[length:240%_100%] after:[mask-composite:exclude] after:[mask:linear-gradient(#fff_0_0)_padding-box,linear-gradient(#fff_0_0)] motion-safe:after:animate-[workflow-node-scan_3s_linear_infinite]',
    state.disabled && 'opacity-55',
    className,
  );
}
