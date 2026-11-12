import { DialogFooter } from '@/components/ui/dialog';
import { SuitePreparation } from './preparation';
import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import type { TestSuites } from '../../hooks/use-test-suites';
export function TestSuiteDialog({ suites }: Readonly<{ suites: TestSuites }>) {
  const [acknowledged, setAcknowledged] = useState(false);
  const locked = suites.start.pending || suites.start.uncertain;
  const preparation = suites.preparation;
  return (
    <Dialog
      open={suites.open}
      onOpenChange={(value) => {
        if (!locked || suites.start.expired) suites.setOpen(value);
      }}
    >
      <DialogContent className="flex max-h-[calc(100svh-2rem)] flex-col gap-4 overflow-y-auto">
        <DialogTitle>Run all tests</DialogTitle>
        <DialogDescription>
          Runs every saved input case against this saved draft, one after
          another. Pins replace their steps. Test results stay for seven days.
        </DialogDescription>
        {suites.preparing ? (
          <p role="status">Saving and preparing cases…</p>
        ) : null}
        {suites.error === undefined ? null : (
          <Notice tone="destructive">{suites.error}</Notice>
        )}
        {preparation === undefined ? null : (
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
            void suites.prepare();
          }}
        />
      </DialogContent>
    </Dialog>
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
    <DialogFooter>
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
          <Button
            disabled={suiteStartBlocked}
            onClick={() =>
              void suites.submit({ acknowledgeSideEffects: acknowledged })
            }
          >
            {suites.start.pending ? 'Starting…' : 'Start suite'}
          </Button>
        </>
      )}
    </DialogFooter>
  );
}
