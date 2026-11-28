import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';

export function ReceiptFooter({
  acknowledgment,
  onDone,
}: Readonly<{ acknowledgment: string; onDone: () => void }>) {
  const [stored, setStored] = useState(false);

  return (
    <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
      <label className="flex cursor-pointer items-center gap-2.5 text-sm">
        <Checkbox checked={stored} onCheckedChange={setStored} />
        {acknowledgment}
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
  );
}
