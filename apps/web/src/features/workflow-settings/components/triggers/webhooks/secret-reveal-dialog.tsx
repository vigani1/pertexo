import { useId, useState } from 'react';
import type { WebhookManagementCommandResponse } from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { webhookAddress } from '../../../model/triggers/endpoint-key';
import { CopyField } from '../../copy-field';

function RevealContent({
  credentials,
  onDone,
}: Readonly<{
  credentials: WebhookManagementCommandResponse;
  onDone: () => void;
}>) {
  const [stored, setStored] = useState(false);
  const storedId = useId();
  return (
    <>
      <DialogTitle>Store these now</DialogTitle>
      <DialogDescription>
        Pertexo shows them once. Keep them in your secrets manager — you can
        rotate them later, but you can’t see them again.
      </DialogDescription>
      <div className="mt-5 flex flex-col gap-4">
        {credentials.endpointKey === undefined ? null : (
          <>
            <CopyField
              label="Webhook address"
              value={webhookAddress(credentials.endpointKey)}
            />
            <CopyField label="Endpoint key" value={credentials.endpointKey} />
          </>
        )}
        {credentials.signingSecret === undefined ? null : (
          <CopyField
            label={
              credentials.trigger.authentication.mode === 'header_secret'
                ? 'Header secret'
                : 'Signing secret'
            }
            value={credentials.signingSecret}
          />
        )}
      </div>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <label
          htmlFor={storedId}
          className="flex cursor-pointer items-center gap-2.5 text-sm"
        >
          <Switch id={storedId} checked={stored} onCheckedChange={setStored} />
          I’ve stored these
        </label>
        <Button
          type="button"
          variant="primary"
          disabled={!stored}
          onClick={onDone}
        >
          Done
        </Button>
      </div>
    </>
  );
}

/**
 * Newly issued webhook credentials, shown once. It can't be dismissed until
 * the person confirms they've stored them.
 */
export function SecretRevealDialog({
  credentials,
  onDone,
}: Readonly<{
  credentials: WebhookManagementCommandResponse | undefined;
  onDone: () => void;
}>) {
  return (
    <Dialog open={credentials !== undefined} disablePointerDismissal>
      <DialogContent className="max-w-xl">
        {credentials === undefined ? null : (
          <RevealContent credentials={credentials} onDone={onDone} />
        )}
      </DialogContent>
    </Dialog>
  );
}
