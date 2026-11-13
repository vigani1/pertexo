import { useQuery } from '@tanstack/react-query';
import { XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/class-names';
import { GuideLink } from '@/components/patterns/guidance/guide-link';
import { HELP_LINKS } from '@/lib/help/guides';
import { shownData } from '@/lib/api/error-copy';
import type { ApiClient } from '@/lib/api/client';
import { workflowSummaryQueryOptions } from '../../data/workflows.queries';
import { firstRunGuideSteps } from '../../model/first-run-guide';

/**
 * The guided first run, above the canvas of the example it created: publish,
 * run, then watch the run's timeline. Each step ties off as it's done; the
 * next one to do is the lit one.
 */
export function FirstRunGuide({
  apiClient,
  userId,
  workspaceId,
  workflowId,
  onDismiss,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
  onDismiss: () => void;
}>) {
  const summary = useQuery(
    workflowSummaryQueryOptions(apiClient, userId, workspaceId, workflowId),
  );
  const published = (shownData(summary)?.publishedVersionId ?? null) !== null;
  const steps = firstRunGuideSteps(published);
  const next = steps.find((step) => !step.done)?.key;
  return (
    <section
      aria-labelledby="first-run-guide-title"
      className="lens pointer-events-auto rounded-xl border-primary/25 px-4 py-3 sm:px-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="first-run-guide-title" className="text-sm font-semibold">
            Your first run
          </h2>
          <p className="text-xs text-muted-foreground">
            This example needs nothing set up. Three steps to see it work.{' '}
            <GuideLink href={HELP_LINKS.firstWorkflow} className="text-xs">
              The full guide
            </GuideLink>
          </p>
        </div>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Hide the first-run guide"
          onClick={onDismiss}
        >
          <XIcon aria-hidden="true" />
        </Button>
      </div>
      <ol className="mt-3 grid gap-3 sm:grid-cols-3">
        {steps.map((step, index) => (
          <li
            key={step.key}
            aria-current={step.key === next ? 'step' : undefined}
            className="flex gap-2.5"
          >
            <span
              aria-hidden="true"
              className={cn(
                'mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border text-xs font-semibold',
                step.done && 'border-success bg-success text-background',
                !step.done &&
                  step.key === next &&
                  'border-primary text-primary shadow-[0_0_0_3px_color-mix(in_srgb,var(--primary)_18%,transparent)]',
                !step.done &&
                  step.key !== next &&
                  'border-surface-ink/20 text-subtle-foreground',
              )}
            >
              {String(index + 1)}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium">
                {step.label}
                {step.done ? (
                  <span className="ml-1.5 text-xs font-normal text-success">
                    Done
                  </span>
                ) : null}
              </span>
              <span className="block text-xs leading-relaxed text-muted-foreground">
                {step.hint}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
