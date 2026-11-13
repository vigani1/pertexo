import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ProgressButton } from '@/components/ui/progress-button';
import { CopyButton } from '@/components/ui/copy-button';
import { Checkbox } from '@/components/ui/checkbox';
import { downloadTextFile } from '@/lib/download-file';

export function RecoveryCodes({
  codes,
  onDone,
  pending,
}: Readonly<{
  codes: readonly string[];
  onDone: () => void;
  pending: boolean;
}>) {
  const [saved, setSaved] = useState(false);
  const text =
    'Pertexo recovery codes — each works once. Keep these somewhere private.\n\n' +
    codes.join('\n') +
    '\n';
  function download() {
    downloadTextFile({
      name: 'pertexo-recovery-codes.txt',
      type: 'text/plain;charset=utf-8',
      text,
    });
  }
  return (
    <div className="mt-6 flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Save these codes in a password manager or another private place. They’re
        shown once; each works once.
      </p>
      <ul
        aria-label="Recovery codes"
        className="grid grid-cols-1 gap-2 font-mono text-sm sm:grid-cols-2"
      >
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <CopyButton value={text} label="Copy recovery codes" />
        <Button type="button" variant="outline" onClick={download}>
          Download .txt
        </Button>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={saved}
          onCheckedChange={setSaved}
          disabled={pending}
        />
        I’ve saved these codes
      </label>
      <ProgressButton
        type="button"
        variant="primary"
        pending={pending}
        pendingLabel="Finishing…"
        disabled={!saved}
        onClick={onDone}
      >
        Done
      </ProgressButton>
    </div>
  );
}
