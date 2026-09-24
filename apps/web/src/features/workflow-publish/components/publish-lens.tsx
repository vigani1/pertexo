import type { WorkflowGraphContract } from '@pertexo/contracts/schemas/workflow-authoring';
import { ArrowUpFromLineIcon, MonitorIcon } from 'lucide-react';
import { useRef } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { LoadingOrb } from '@/components/ui/loading-orb';
import { Status, type StatusTone } from '@/components/ui/status';
import { cn } from '@/lib/utils';
import type { PublishSummary } from '../model/publish-summary';
import type { WorkflowIssueGroup } from '../model/workflow-issues';
import type { WorkflowValidationTarget } from '../model/validation-target';
import type { PublishStage } from '../mutations/use-workflow-publication';
import { IssuesList } from './issues-list';
import { PublishChanges } from './publish-changes';

const stages: readonly Readonly<{ stage: PublishStage; label: string }>[] = [
  { stage: 'saving', label: 'Saving your last change' },
  { stage: 'checking', label: 'Checking for issues' },
  { stage: 'publishing', label: 'Writing the new version' },
];

/**
 * What publishing will do before it happens: the change summary against
 * the live version, anything blocking it, and what happens to triggers and
 * runs already in progress. Confirming shows the real steps as they run.
 */
export function PublishLens({
  open,
  onOpenChange,
  versionLabel,
  summary,
  summaryState,
  graph,
  stage,
  error,
  recoveryPending,
  blockingGroups,
  onPublish,
  onFix,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  versionLabel: string;
  summary: PublishSummary | undefined;
  summaryState: 'loading' | 'error' | 'ready';
  graph: WorkflowGraphContract;
  stage: PublishStage | undefined;
  error: string | undefined;
  recoveryPending: boolean;
  blockingGroups: readonly WorkflowIssueGroup[];
  onPublish: () => void;
  onFix: (target: WorkflowValidationTarget) => void;
}>) {
  const pending = stage !== undefined;
  // Fix moves focus to the field it names; closing must not take it back.
  const fixing = useRef(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) fixing.current = false;
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogContent
        className={cn(pending && 'live-edge')}
        finalFocus={() => !fixing.current}
      >
        <DialogTitle>
          {pending ? `Publishing ${versionLabel}…` : `Publish ${versionLabel}`}
        </DialogTitle>
        <DialogDescription>
          {recoveryPending
            ? 'Retrying sends the same publish again, for the same saved draft. It can’t create two versions, and newer edits aren’t included.'
            : 'Publishing makes the saved draft the version that runs. The draft stays editable.'}
        </DialogDescription>
        {pending ? (
          <PublishProgress stage={stage} />
        ) : (
          <div className="mt-5 flex flex-col gap-5">
            <PublishChanges summary={summary} state={summaryState} />
            {blockingGroups.length === 0 ? null : (
              <section aria-label="Blocking issues">
                <h3 className="text-sm font-semibold text-destructive">
                  Fix these first
                </h3>
                <div className="mt-2">
                  <IssuesList
                    groups={blockingGroups}
                    graph={graph}
                    onFix={(target) => {
                      fixing.current = true;
                      onOpenChange(false);
                      onFix(target);
                    }}
                  />
                </div>
              </section>
            )}
            <WhatHappens summary={summary} versionLabel={versionLabel} />
            <p className="flex items-start gap-2 text-xs text-subtle-foreground lg:hidden">
              <MonitorIcon aria-hidden="true" className="mt-px size-3.5" />
              Publishing works here, but reviewing changes is easier on a larger
              screen.
            </p>
          </div>
        )}
        {error === undefined ? null : (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <DialogClose
            render={<Button type="button" variant="ghost" disabled={pending} />}
          >
            Cancel
          </DialogClose>
          <Button
            type="button"
            variant="primary"
            disabled={pending || blockingGroups.length > 0}
            onClick={onPublish}
          >
            {pending ? (
              <LoadingOrb />
            ) : (
              <ArrowUpFromLineIcon data-icon="inline-start" />
            )}
            {pending
              ? 'Publishing…'
              : recoveryPending
                ? 'Retry original publish'
                : error === undefined
                  ? `Publish ${versionLabel}`
                  : 'Try again'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PublishProgress({ stage }: Readonly<{ stage: PublishStage }>) {
  const activeIndex = stages.findIndex(
    (candidate) => candidate.stage === stage,
  );
  return (
    <ol className="mt-5 flex flex-col gap-2.5" aria-label="Publishing steps">
      {stages.map((step, index) => {
        const tone: StatusTone =
          index < activeIndex
            ? 'success'
            : index === activeIndex
              ? 'live'
              : 'queued';
        return (
          <li
            key={step.stage}
            aria-current={index === activeIndex ? 'step' : undefined}
          >
            <Status
              tone={tone}
              className={cn(
                'text-sm font-medium',
                index > activeIndex && 'text-subtle-foreground',
              )}
            >
              {step.label}
            </Status>
          </li>
        );
      })}
    </ol>
  );
}

function WhatHappens({
  summary,
  versionLabel,
}: Readonly<{ summary: PublishSummary | undefined; versionLabel: string }>) {
  const triggers = summary?.triggerNames ?? [];
  return (
    <section aria-label="What happens next">
      <h3 className="text-sm font-semibold">What happens</h3>
      <ul className="mt-2 flex list-disc flex-col gap-1 pl-4 text-sm text-muted-foreground">
        <li>
          {triggers.length === 0
            ? `Runs you start after this use ${versionLabel}.`
            : `${joinNames(triggers)} ${triggers.length === 1 ? 'starts' : 'start'} ${versionLabel} once it’s live.`}
        </li>
        <li>
          Runs already in progress finish on the version they started with.
        </li>
      </ul>
    </section>
  );
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}
