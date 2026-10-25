import { DialogFooter } from '@/components/ui/dialog';
import { useState } from 'react';
import type { FailureNotificationDestinationResponse } from '@pertexo/contracts';
import {
  TestThread,
  type TestPhase,
} from '@/features/connections/provider.public';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Status } from '@/components/ui/status';
import type { DestinationMutationScope } from '../data/failure-notifications.mutations';
import { useDestinationTest } from '../hooks/use-destination-test';

export function DestinationTest({
  scope,
  destination,
  label,
  disabled,
}: Readonly<{
  scope: DestinationMutationScope;
  destination: FailureNotificationDestinationResponse;
  label: string;
  disabled: boolean;
}>) {
  const [confirming, setConfirming] = useState(false);
  const test = useDestinationTest(scope, destination);
  const uncertain = test.phase === 'unsure';
  const pending = test.phase === 'running';
  const idleSendLabel = uncertain ? 'Check result' : 'Send test';
  const send = () => {
    setConfirming(false);
    test.run();
  };
  return (
    <div className="col-span-full w-full max-w-sm min-w-0 pt-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Send a test alert to check this destination
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || pending}
          aria-label={
            uncertain
              ? `Check test result for ${label}`
              : `Send test to ${label}`
          }
          onClick={() => {
            if (uncertain) send();
            else setConfirming(true);
          }}
        >
          {pending ? 'Sending…' : idleSendLabel}
        </Button>
      </div>
      <TestThread
        provider={destination.kind}
        phase={test.phase}
        className="mt-3 h-20"
      />
      <div
        aria-live="polite"
        aria-atomic="true"
        className="mt-2 text-xs text-muted-foreground"
      >
        <DestinationTestResult phase={test.phase} label={label} />
      </div>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogTitle>Send a test alert</DialogTitle>
          <DialogDescription>
            Send one real test message to {label}? It will say that no workflow
            failed.
          </DialogDescription>
          <DialogFooter className="mt-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setConfirming(false);
              }}
            >
              Cancel
            </Button>
            <Button type="button" variant="primary" onClick={send}>
              Send test
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DestinationTestResult({
  phase,
  label,
}: Readonly<{ phase: TestPhase; label: string }>) {
  switch (phase) {
    case 'running':
      return <Status tone="live">Sending one test message…</Status>;
    case 'ok':
      return (
        <Status tone="success">The service accepted the test message.</Status>
      );
    case 'unsure':
      return (
        <p>
          Delivery wasn’t confirmed. Check the destination before another test.
          Check result repeats this attempt without sending again.
        </p>
      );
    case 'failed':
      return (
        <p>
          The test couldn’t be sent. Review the destination and its connection
          before trying again.
        </p>
      );
    case 'idle':
      return <p>A test sends one real message to {label}.</p>;
  }
}
