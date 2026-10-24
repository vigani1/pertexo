import { ProgressButton } from '@/components/ui/progress-button';
import { DialogClose } from '@/components/ui/dialog';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { WebhookTestEventSnapshot } from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import { Status } from '@/components/ui/status';
import { JsonTree } from '@/components/patterns/code/json-tree';
import {
  ConfirmDialog,
  ConfirmationFooter,
  ConfirmationDetails,
} from '@/components/patterns/actions/confirm-dialog';
import type { SampleScope } from '../../data/samples/api';
import { stepSampleQueryOptions } from '../../data/samples/queries';
import { useSampleCommand } from '../samples/use-command';
export function CapturedEvent({
  scope,
  nodeId,
  listenerId,
  output,
  ensureSaved,
}: {
  scope: SampleScope;
  nodeId: string;
  listenerId: string;
  output: NonNullable<WebhookTestEventSnapshot['output']>;
  ensureSaved: () => Promise<{ revision: number }>;
}) {
  const sample = useQuery(stepSampleQueryOptions(scope, nodeId));
  const [confirm, setConfirm] = useState(false);
  const [kept, setKept] = useState(false);
  const pin = useSampleCommand(scope, nodeId, ensureSaved, () => {
    setConfirm(false);
    setKept(true);
  });
  const confirmBlocked =
    pin.pending || sample.data === undefined || pin.expired;
  return (
    <>
      <JsonTree value={output.value} label="Received test data" />
      {kept ? (
        <Status tone="success">Kept as pinned sample</Status>
      ) : (
        <Button
          size="sm"
          disabled={sample.data === undefined || sample.isError}
          onClick={() => {
            setConfirm(true);
          }}
        >
          Keep as pinned sample
        </Button>
      )}
      {confirm ? (
        <ConfirmDialog
          state={{ open: true, onOpenChange: setConfirm, locked: pin.pending }}
          title="Keep this test event?"
          description={
            sample.data?.sample === null
              ? 'The received data will be shared as this trigger’s pinned output. Check it for secrets first.'
              : 'This replaces the trigger’s existing pin. The received data will be shared with people who can see run data. Check it for secrets first.'
          }
          onSubmit={() => {
            if (pin.uncertain) pin.retry();
            else if (sample.data !== undefined)
              void pin.save(
                { kind: 'webhook_test', listenerId },
                sample.data.sample,
              );
          }}
          submitDisabled={confirmBlocked}
          footer={
            <ConfirmationFooter>
              <DialogClose
                disabled={pin.pending}
                render={<Button type="button" variant="ghost" />}
              >
                Cancel
              </DialogClose>
              <ProgressButton
                type="submit"
                variant="primary"
                pending={pin.pending}
                pendingLabel="Keeping…"
                disabled={sample.data === undefined || pin.expired}
              >
                {pin.uncertain ? 'Retry the same pin' : 'Keep as pinned sample'}
              </ProgressButton>
            </ConfirmationFooter>
          }
        >
          <ConfirmationDetails error={pin.error} />
        </ConfirmDialog>
      ) : null}
    </>
  );
}
