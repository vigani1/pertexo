import { ProgressButton } from '@/components/ui/progress-button';
import { DialogClose } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useState } from 'react';
import {
  ConfirmDialog,
  ConfirmationFooter,
  ConfirmationDetails,
} from '@/components/patterns/actions/confirm-dialog';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import { extractEndpointKey } from '../../../model/triggers/endpoint-key';

function endpointProblem(pasted: string): string | undefined {
  return extractEndpointKey(pasted) === undefined
    ? 'That doesn’t contain an endpoint key. Paste the full address ending in /hooks/…, or the 43-character key on its own.'
    : undefined;
}

/**
 * Rotating the signing secret needs the current endpoint key. People paste
 * the address they gave senders, or the key, and the key is taken from it.
 */
export function RotateSecretDialog({
  open,
  headerSecret = false,
  pending,
  onRotate,
  onClose,
}: Readonly<{
  open: boolean;
  headerSecret?: boolean;
  pending: boolean;
  onRotate: (endpointKey: string) => Promise<unknown>;
  onClose: () => void;
}>) {
  const [pasted, setPasted] = useState('');
  const validation = useFieldValidation<'endpoint'>();

  function clear() {
    setPasted('');
    validation.reset();
  }

  return (
    <ConfirmDialog
      state={{
        open: open,
        onOpenChange: (next) => {
          if (next) return;
          clear();
          onClose();
        },
        locked: pending,
      }}
      title={
        headerSecret ? 'Rotate the header secret' : 'Rotate the signing secret'
      }
      description="Senders using the current secret keep working for 5 more minutes, then need the new one."
      onSubmit={async () => {
        if (!validation.submit({ endpoint: endpointProblem(pasted) })) return;
        const endpointKey = extractEndpointKey(pasted);
        if (endpointKey !== undefined)
          await onRotate(endpointKey).finally(clear);
      }}
      submitDisabled={pending}
      footer={
        <ConfirmationFooter>
          <DialogClose
            disabled={pending}
            render={<Button type="button" variant="ghost" />}
          >
            Cancel
          </DialogClose>
          <ProgressButton
            type="submit"
            variant="primary"
            pending={pending}
            pendingLabel="Rotating…"
          >
            Rotate secret
          </ProgressButton>
        </ConfirmationFooter>
      }
    >
      <ConfirmationDetails>
        <LabelledField
          id="current-endpoint"
          label="Current address or endpoint key"
          description="Pertexo uses it to confirm which endpoint you mean. It isn’t stored here."
          error={validation.error('endpoint')}
        >
          {(control) => (
            <Input
              {...control}
              ref={validation.register('endpoint')}
              name="currentEndpoint"
              type="password"
              autoComplete="off"
              autoFocus
              disabled={pending}
              value={pasted}
              onChange={(event) => {
                setPasted(event.target.value);
                validation.change(
                  'endpoint',
                  endpointProblem(event.target.value),
                );
              }}
            />
          )}
        </LabelledField>
      </ConfirmationDetails>
    </ConfirmDialog>
  );
}
