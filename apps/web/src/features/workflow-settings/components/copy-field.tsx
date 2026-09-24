import { useState } from 'react';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** A labelled value in mono with a copy button that confirms in place. */
export function CopyField({
  label,
  value,
  display,
  className,
}: Readonly<{
  label: string;
  value: string;
  /** What to show when it differs from what's copied, e.g. a short ID. */
  display?: string;
  className?: string;
}>) {
  const [state, setState] = useState<'idle' | 'copied' | 'blocked'>('idle');

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('blocked');
    }
  }

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex min-w-0 items-start gap-2">
        <code className="min-w-0 flex-1 rounded-md border border-border bg-black/30 px-3 py-2 font-mono text-[0.8rem] break-all text-foreground">
          {display ?? value}
        </code>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={() => void copy()}
        >
          {state === 'copied' ? (
            <CheckIcon aria-hidden="true" className="text-success" />
          ) : (
            <CopyIcon aria-hidden="true" />
          )}
        </Button>
      </div>
      <span role="status" className="text-xs text-subtle-foreground">
        {state === 'copied'
          ? 'Copied.'
          : state === 'blocked'
            ? 'Your browser blocked copying. Select the text and copy it instead.'
            : ''}
      </span>
    </div>
  );
}
