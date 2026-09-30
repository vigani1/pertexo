import { PlusIcon } from 'lucide-react';
import { useId } from 'react';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { bodyIssuesOf } from '../../model/graph/for-each-body-rules';
import { useEditorStore } from '../../model/editor-store-context';
import { loopSummary } from '../../model/graph/graph-adapter';
import type { WorkflowNode } from '../../model/graph/graph-scopes';
import type { NodeFormApi } from '../../model/inspector/node-form';
import { LoopBoundsFields } from './loop-bounds-fields';

/**
 * A For each step's body (ADR 020): it runs once per item within its item
 * and concurrency bounds, and the steps after it wait for every item. Its
 * steps open from here, a step can be added to it, and what the body still
 * needs is listed, so building a body never depends on the canvas alone.
 */
export function LoopBodySection({
  node,
  form,
  onSelectStep,
  onAddStep,
}: Readonly<{
  node: WorkflowNode;
  form: NodeFormApi;
  onSelectStep: (nodeId: string) => void;
  /** Opens the step picker for the body, returning focus to `opener`. */
  onAddStep: (opener: HTMLElement) => void;
}>) {
  const headingId = useId();
  const loop = loopSummary(node);
  const issues = useEditorStore((state) => bodyIssuesOf(state.graph, node.id));
  const bounds =
    loop === null
      ? ''
      : `, up to ${String(loop.maxIterations)} ${loop.maxIterations === 1 ? 'item' : 'items'} and ${String(loop.maxConcurrency)} at a time`;
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-2 rounded-lg border border-dashed border-secondary/30 bg-secondary/[0.04] p-3 text-sm"
    >
      <h3 id={headingId} className="font-semibold">
        Runs once per item
      </h3>
      <p className="text-muted-foreground">
        Its body runs for each item it’s given{bounds}. Steps after it continue
        once every item has finished.
      </p>
      {node.structured === undefined ? null : (
        <LoopBoundsFields structure={node.structured} form={form} />
      )}
      {loop === null || loop.steps.length === 0 ? null : (
        <ul aria-label="Body steps" className="flex flex-col gap-1">
          {loop.steps.map((step) => (
            <li key={step.id}>
              <button
                type="button"
                className="w-full truncate rounded-sm border border-white/6 bg-white/4 px-2 py-1 text-left text-[0.8rem] outline-none hover:border-white/12 focus-ring"
                onClick={() => {
                  onSelectStep(step.id);
                }}
              >
                {step.title}
              </button>
            </li>
          ))}
        </ul>
      )}
      {issues.length === 0 ? null : (
        <Notice tone="warning" title="The body isn’t ready yet">
          <ul className="flex flex-col gap-1">
            {issues.map((issue) => (
              <li key={issue.code}>{issue.message}</li>
            ))}
          </ul>
        </Notice>
      )}
      {form.editable ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="w-fit"
          onClick={(event) => {
            onAddStep(event.currentTarget);
          }}
        >
          <PlusIcon data-icon="inline-start" />
          Add step to body
        </Button>
      ) : null}
    </section>
  );
}
