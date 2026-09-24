import { useState } from 'react';
import { ConfirmDialog } from '@/components/patterns/confirm-dialog';
import {
  Field,
  FieldControl,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { extractEndpointKey } from '../../model/endpoint-key';

/**
 * Rotating the signing secret needs the current endpoint key. People paste
 * the address they gave senders, or the key, and the key is taken from it.
 */
export function RotateSecretDialog({
  open,
  pending,
  onRotate,
  onClose,
}: Readonly<{
  open: boolean;
  pending: boolean;
  onRotate: (endpointKey: string) => Promise<unknown>;
  onClose: () => void;
}>) {
  const [pasted, setPasted] = useState('');
  const [validation, setValidation] = useState<'invalid' | 'corrected'>();
  const invalid = validation === 'invalid';

  function clear() {
    setPasted('');
    setValidation(undefined);
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        clear();
        onClose();
      }}
      title="Rotate the signing secret"
      description="Senders using the current secret keep working for 5 more minutes, then need the new one."
      confirmLabel="Rotate secret"
      pendingLabel="Rotating…"
      pending={pending}
      onConfirm={async () => {
        const endpointKey = extractEndpointKey(pasted);
        if (endpointKey === undefined) {
          setValidation('invalid');
          return;
        }
        await onRotate(endpointKey).finally(clear);
      }}
    >
      <Field data-invalid={invalid}>
        <FieldLabel htmlFor="current-endpoint">
          Current address or endpoint key
        </FieldLabel>
        <FieldControl state={validation}>
          <Input
            id="current-endpoint"
            name="currentEndpoint"
            type="password"
            autoComplete="off"
            autoFocus
            disabled={pending}
            value={pasted}
            aria-invalid={invalid}
            aria-describedby={
              invalid ? 'current-endpoint-error' : 'current-endpoint-help'
            }
            onChange={(event) => {
              setPasted(event.target.value);
              if (validation !== undefined)
                setValidation(
                  extractEndpointKey(event.target.value) === undefined
                    ? 'invalid'
                    : 'corrected',
                );
            }}
          />
        </FieldControl>
        {invalid ? (
          <FieldError id="current-endpoint-error">
            That doesn’t contain an endpoint key. Paste the full address ending
            in /hooks/…, or the 43-character key on its own.
          </FieldError>
        ) : (
          <FieldDescription id="current-endpoint-help">
            Pertexo uses it to confirm which endpoint you mean. It isn’t stored
            here.
          </FieldDescription>
        )}
      </Field>
    </ConfirmDialog>
  );
}
