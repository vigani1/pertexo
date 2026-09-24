import { useState } from 'react';
import { ConfirmDialog } from '@/components/patterns/confirm-dialog';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import { extractEndpointKey } from '../../model/endpoint-key';

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
  const validation = useFieldValidation<'endpoint'>();

  function clear() {
    setPasted('');
    validation.reset();
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
        if (!validation.submit({ endpoint: endpointProblem(pasted) })) return;
        const endpointKey = extractEndpointKey(pasted);
        if (endpointKey !== undefined)
          await onRotate(endpointKey).finally(clear);
      }}
    >
      <LabelledField
        id="current-endpoint"
        label="Current address or endpoint key"
        description="Pertexo uses it to confirm which endpoint you mean. It isn’t stored here."
        error={validation.error('endpoint')}
        thread={validation.thread('endpoint')}
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
            onBlur={() => {
              validation.blur('endpoint', endpointProblem(pasted));
            }}
          />
        )}
      </LabelledField>
    </ConfirmDialog>
  );
}
