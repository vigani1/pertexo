import { ReceiptFooter } from '@/components/patterns/actions/receipt-footer';
import { useId } from 'react';
import { CopyButton } from '@/components/ui/copy-button';
import { DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { StatusMark } from '@/components/patterns/status/status-mark';
import { Textarea } from '@/components/ui/textarea';

export function TokenSecretReceipt({
  secret,
  name,
  onDone,
}: Readonly<{
  secret: string;
  name: string;
  onDone: () => void;
}>) {
  const id = useId();
  return (
    <>
      <DialogTitle>Save this token now</DialogTitle>
      <DialogDescription>
        Pertexo shows the secret once. Save it in your secrets manager before
        closing. It cannot be retrieved later.
      </DialogDescription>
      <StatusMark tone="success" className="mt-4">
        Token created
      </StatusMark>
      <p className="mt-2 break-words text-sm">{name}</p>
      <div className="mt-5 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <label htmlFor={id} className="text-sm font-semibold">
            API token secret
          </label>
          <CopyButton value={secret} label="Copy API token secret" />
        </div>
        <Textarea
          id={id}
          readOnly
          value={secret}
          spellCheck={false}
          autoComplete="off"
          typography="compact-code"
          className="min-h-28 break-all"
        />
      </div>
      <ReceiptFooter acknowledgment="I’ve saved this token" onDone={onDone} />
    </>
  );
}
