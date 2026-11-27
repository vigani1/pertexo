import { SheetFooter } from '@/components/ui/sheet';
import { SuitePreparation } from './preparation';
import { EvaluationSetup } from './evaluation';
import { useState } from 'react';
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/patterns/notices/inline-notice';
import type { TestSuites } from '../../data/test-suites/workflow-test-suites.mutations';
import { DATA_RETENTION_DAYS } from '@pertexo/workflow-model';
import { formatCount } from '@/lib/format/count';
export function TestSuiteDialog({ suites }: Readonly<{ suites: TestSuites }>) {
  const [acknowledged, setAcknowledged] = useState(false);
  const locked = suites.start.pending || suites.start.uncertain;
  const preparation = suites.preparation;
  const evaluation = suites.caseSource === 'table';
  return (
    <Sheet
      open={suites.open}
      onOpenChange={(value) => {
        if (!locked || suites.start.expired) suites.setOpen(value);
      }}
    >
      <SheetContent
        variant="form"
        className="flex max-h-[calc(100svh-2rem)] flex-col gap-4 overflow-y-auto"
      >
        <SheetTitle>
          {evaluation ? 'Evaluate data table' : 'Run all tests'}
        </SheetTitle>
        <SheetDescription>
          {evaluation
            ? 'Runs one case for each row in the table you select. Test results stay for '
            : 'Runs every saved input case against this saved draft, one after another. Pins replace their steps. Test results stay for '}
          {formatCount(DATA_RETENTION_DAYS.testRuns, 'day')}.
        </SheetDescription>
        {suites.preparing ? (
          <p role="status">Saving and preparing cases…</p>
        ) : null}
        {suites.error === undefined ? null : (
          <Notice tone="destructive">{suites.error}</Notice>
        )}
        {evaluation && suites.open ? (
          <EvaluationSetup suites={suites} locked={locked} />
        ) : null}
        {evaluation || preparation === undefined ? null : (
          <SuitePreparation
            preparation={preparation}
            acknowledged={acknowledged}
            onAcknowledgedChange={setAcknowledged}
            locked={locked}
          />
        )}
        {suites.startError === undefined ? null : (
          <Notice tone="destructive">{suites.startError}</Notice>
        )}
        <SuiteStartActions
          suites={suites}
          acknowledged={acknowledged}
          onPrepare={() => {
            setAcknowledged(false);
            void suites.prepare(suites.caseSource);
          }}
        />
      </SheetContent>
    </Sheet>
  );
}

function SuiteStartActions({
  suites,
  acknowledged,
  onPrepare,
}: Readonly<{
  suites: TestSuites;
  acknowledged: boolean;
  onPrepare: () => void;
}>) {
  const locked = suites.start.pending || suites.start.uncertain,
    preparation = suites.preparation;
  const suiteStartBlocked =
    locked ||
    preparation === undefined ||
    preparation.cases.length === 0 ||
    (preparation.effectfulSteps.length > 0 && !acknowledged);
  return (
    <SheetFooter>
      <Button
        variant="ghost"
        disabled={locked && !suites.start.expired}
        onClick={() => {
          suites.setOpen(false);
        }}
      >
        Close
      </Button>
      {suites.start.uncertain ? (
        <Button
          disabled={suites.start.pending || suites.start.expired}
          onClick={suites.start.retry}
        >
          Retry same suite request
        </Button>
      ) : (
        <>
          <Button
            variant="outline"
            disabled={locked || suites.preparing}
            onClick={onPrepare}
          >
            Prepare again
          </Button>
          {suites.caseSource === 'table' ? null : (
            <Button
              disabled={suiteStartBlocked}
              onClick={() =>
                void suites.submit({ acknowledgeSideEffects: acknowledged })
              }
            >
              {suites.start.pending ? 'Starting…' : 'Start suite'}
            </Button>
          )}
        </>
      )}
    </SheetFooter>
  );
}
