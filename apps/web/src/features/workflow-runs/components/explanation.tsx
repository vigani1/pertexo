import type {
  explainFailedRunResultSchema,
  explanationDisclosureSchema,
} from '@pertexo/contracts';
import type { z } from 'zod';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import type { ApiClient } from '@/lib/api/client';
import { describeReadError } from '@/lib/api/error-copy';
import { FORMAT_LOCALE } from '@/lib/format/locale';
import { useRunExplanation } from '../data/explanation.mutations';
import { explanationCopy } from '../model/presentation/explanation-copy';
import { ModelUsageDetails } from './model-usage';

export function RunExplanation({
  apiClient,
  workspaceId,
  runId,
  onSelectStep,
}: Readonly<{
  apiClient: ApiClient;
  workspaceId: string;
  runId: string;
  onSelectStep: (id: string) => void;
}>) {
  const [open, setOpen] = useState(false);
  const { disclosure, explanation } = useRunExplanation(
    apiClient,
    workspaceId,
    runId,
  );
  const destination = disclosure.data;
  const report = explanation.data;
  const pending = disclosure.isPending || explanation.isPending;
  const error = disclosure.error ?? explanation.error;
  const failure = report ?? destination;
  const explained = report?.kind === 'explained';
  const canSend =
    destination?.kind === 'ready' &&
    !explained &&
    report?.kind !== 'confirmation_changed';

  async function changeOpen(next: boolean) {
    setOpen(next);
    if (next && report?.kind !== 'explained' && !pending) {
      explanation.reset();
      await disclosure.mutateAsync().catch(() => undefined);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        void changeOpen(next);
      }}
    >
      <DialogTrigger
        render={<Button variant="outline" size="sm" className="self-start" />}
      >
        Explain failed run
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>
          {explained ? 'Run explanation' : 'Explain failed run'}
        </DialogTitle>
        <ExplanationBody
          report={report}
          destination={destination}
          onSelect={(id) => {
            setOpen(false);
            onSelectStep(id);
          }}
        />
        {pending ? (
          <p role="status" className="mt-4 text-sm text-muted-foreground">
            {explanation.isPending
              ? 'Waiting for the model…'
              : 'Checking the assistant settings…'}
          </p>
        ) : null}
        <ExplanationFeedback error={error} outcome={failure} />
        <DialogFooter className="mt-5">
          <DialogClose render={<Button variant="outline" />}>
            {explained ? 'Close' : 'Cancel'}
          </DialogClose>
          {canSend ? (
            <Button
              disabled={pending}
              onClick={() => {
                void explanation
                  .mutateAsync(destination.confirmation)
                  .catch(() => undefined);
              }}
            >
              Send to model
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type Result = z.output<typeof explainFailedRunResultSchema>;
type Destination = z.output<typeof explanationDisclosureSchema>;

function ExplanationBody({
  report,
  destination,
  onSelect,
}: Readonly<{
  report: Result | undefined;
  destination: Destination | undefined;
  onSelect: (id: string) => void;
}>) {
  if (report?.kind === 'explained')
    return (
      <div className="mt-4 flex flex-col gap-4">
        <p className="whitespace-pre-wrap wrap-anywhere text-sm">
          {report.explanation}
        </p>
        {report.steps.length === 0 ? null : (
          <div className="flex flex-wrap gap-2">
            {report.steps.map((step) => (
              <Button
                key={step.id}
                variant="outline"
                size="sm"
                onClick={() => {
                  onSelect(step.id);
                }}
              >
                {step.label}
              </Button>
            ))}
          </div>
        )}
        <ModelUsageDetails usage={report.usage} />
        {report.costNanoDollars === null ? null : (
          <p className="text-xs text-muted-foreground">
            Estimated cost {formatCost(report.costNanoDollars)}
          </p>
        )}
      </div>
    );
  if (destination?.kind !== 'ready') return null;
  return (
    <DialogDescription>
      <span className="block">
        Send this request to <strong>{destination.connectionName}</strong> at{' '}
        <strong>{destination.host}</strong> using{' '}
        <strong>{destination.model}</strong>.
      </span>
      <span className="mt-3 block">
        The request includes the workflow version, run status and trigger type,
        recent step IDs, labels, types and statuses, the failed step and the
        safe error codes.
      </span>
    </DialogDescription>
  );
}

function ExplanationFeedback({
  error,
  outcome,
}: Readonly<{
  error: Error | null;
  outcome: Result | Destination | undefined;
}>) {
  if (error !== null)
    return (
      <p role="alert" className="mt-4 text-sm text-destructive">
        {describeReadError(error, 'The run explanation')}
      </p>
    );
  if (
    outcome === undefined ||
    outcome.kind === 'ready' ||
    outcome.kind === 'explained'
  )
    return null;
  return (
    <p role="status" className="mt-4 text-sm text-muted-foreground">
      {explanationCopy[outcome.kind]}
    </p>
  );
}

const NANO_DOLLARS_PER_DOLLAR = 1_000_000_000;
const MODEL_COST_FORMAT = new Intl.NumberFormat(FORMAT_LOCALE, {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 9,
});

function formatCost(cost: number) {
  return MODEL_COST_FORMAT.format(cost / NANO_DOLLARS_PER_DOLLAR);
}
