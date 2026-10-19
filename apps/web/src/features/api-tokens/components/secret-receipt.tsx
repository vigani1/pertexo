import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { CopyButton } from '@/components/ui/copy-button';
import { DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Status } from '@/components/ui/status';
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
  const [stored, setStored] = useState(false);
  return (
    <>
      <DialogTitle>Save this token now</DialogTitle>
      <DialogDescription>
        Pertexo shows the secret once. Save it in your secrets manager before
        closing. It cannot be retrieved later.
      </DialogDescription>
      <Status tone="success" className="mt-4">
        Token created
      </Status>
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
          className="min-h-28 font-mono text-base break-all md:text-xs"
        />
      </div>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <label className="flex cursor-pointer items-center gap-2.5 text-sm">
          <Checkbox checked={stored} onCheckedChange={setStored} />
          I’ve saved this token
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
