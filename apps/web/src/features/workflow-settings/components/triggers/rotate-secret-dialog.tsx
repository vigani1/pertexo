import { useState, type SyntheticEvent } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Field,
  FieldControl,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { LoadingOrb } from '@/components/ui/loading-orb';
import { extractEndpointKey } from '../../model/endpoint-key';

function RotateSecretForm({
  pending,
  onRotate,
}: Readonly<{
  pending: boolean;
  onRotate: (endpointKey: string) => void;
}>) {
  const [pasted, setPasted] = useState('');
  const [validation, setValidation] = useState<'invalid' | 'corrected'>();
  const invalid = validation === 'invalid';

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const endpointKey = extractEndpointKey(pasted);
    if (endpointKey === undefined) {
      setValidation('invalid');
      return;
    }
    onRotate(endpointKey);
  }

  return (
    <form noValidate className="mt-5 flex flex-col gap-6" onSubmit={submit}>
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
      <div className="flex justify-end gap-2">
        <DialogClose
          render={<Button type="button" variant="ghost" disabled={pending} />}
        >
          Cancel
        </DialogClose>
        <Button type="submit" disabled={pending}>
          {pending ? <LoadingOrb /> : null}
          {pending ? 'Rotating…' : 'Rotate secret'}
        </Button>
      </div>
    </form>
  );
}

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
  onRotate: (endpointKey: string) => void;
  onClose: () => void;
}>) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>Rotate the signing secret</DialogTitle>
        <DialogDescription>
          Senders using the current secret keep working for 5 more minutes, then
          need the new one.
        </DialogDescription>
        {open ? (
          <RotateSecretForm pending={pending} onRotate={onRotate} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
