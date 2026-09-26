import { ChevronRightIcon } from 'lucide-react';
import { useRef } from 'react';
import type { WorkflowVersionResponse } from '@pertexo/contracts/schemas/workflow-authoring';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { PatternGlyph } from '@/features/workflows/shape.public';
import { formatDateTime, formatRelativeTime } from '@/lib/format-time';
import { stepCountLabel, versionSteps } from '../../model/version-steps';
import { CopyField } from '../copy-field';
import { VersionDiffSummary } from './version-diff-summary';

function VersionChanges({
  version,
  previous,
}: Readonly<{
  version: WorkflowVersionResponse;
  previous: WorkflowVersionResponse | undefined;
}>) {
  if (previous === undefined)
    return (
      <p className="text-sm text-muted-foreground">
        The first published version.
      </p>
    );
  return <VersionDiffSummary from={previous} to={version} />;
}

/** A read-only look at one version: its shape, its steps and what changed. */
export function VersionPreviewSheet({
  version,
  previous,
  canRestore,
  onRestore,
  onClose,
}: Readonly<{
  version: WorkflowVersionResponse | undefined;
  previous: WorkflowVersionResponse | undefined;
  canRestore: boolean;
  onRestore: (version: WorkflowVersionResponse) => void;
  onClose: () => void;
}>) {
  // Focus lands on Close, outside the scrolling body, so opening never
  // scrolls the shape and steps out of view.
  const closeRef = useRef<HTMLButtonElement>(null);
  return (
    <Sheet
      open={version !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        initialFocus={closeRef}
        className="w-[min(32rem,calc(100vw-1.5rem))]"
      >
        {version === undefined ? null : (
          <>
            <SheetHeader>
              <SheetTitle>v{String(version.versionNumber)}</SheetTitle>
              <SheetDescription>
                Published {formatRelativeTime(version.publishedAt)} ·{' '}
                {formatDateTime(version.publishedAt)} ·{' '}
                {stepCountLabel(version.graph.nodes.length)}
              </SheetDescription>
            </SheetHeader>
            <SheetBody className="flex flex-col gap-6">
              <div className="weave grid place-items-center rounded-lg border border-border px-4 py-6">
                <PatternGlyph graph={version.graph} size="lens" />
              </div>
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold">Steps</h3>
                <ol className="flex flex-col divide-y divide-border rounded-lg border border-border">
                  {versionSteps(version.graph).map((step) => (
                    <li
                      key={step.id}
                      className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                    >
                      <span className="min-w-0 truncate font-medium">
                        {step.label}
                      </span>
                      {/* The type only when the name doesn't already say it. */}
                      {step.label === step.kind && !step.trigger ? null : (
                        <span className="shrink-0 text-xs text-subtle-foreground">
                          {step.trigger
                            ? step.label === step.kind
                              ? 'Trigger'
                              : `Trigger · ${step.kind}`
                            : step.kind}
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
              </section>
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold">Changes</h3>
                <VersionChanges version={version} previous={previous} />
              </section>
              <details className="group/details rounded-lg border border-border px-3 py-2 text-sm">
                {/* The app's chevron instead of the browser's own marker. */}
                <summary className="flex cursor-pointer list-none items-center gap-1.5 text-muted-foreground [&::-webkit-details-marker]:hidden">
                  <ChevronRightIcon
                    aria-hidden="true"
                    className="size-3.5 transition-transform group-open/details:rotate-90 motion-reduce:transition-none"
                  />
                  Details
                </summary>
                <div className="mt-3 flex flex-col gap-3">
                  <CopyField
                    label="Version ID"
                    value={version.id}
                    display={`${version.id.slice(0, 8)}…`}
                  />
                  <CopyField
                    label="Checksum"
                    value={version.checksum}
                    display={`${version.checksum.slice(0, 24)}…`}
                  />
                </div>
              </details>
            </SheetBody>
            <SheetFooter>
              <SheetClose
                render={<Button ref={closeRef} type="button" variant="ghost" />}
              >
                Close
              </SheetClose>
              {canRestore ? (
                <Button
                  type="button"
                  onClick={() => {
                    onRestore(version);
                  }}
                >
                  Restore to draft
                </Button>
              ) : null}
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
