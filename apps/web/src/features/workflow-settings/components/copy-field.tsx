import { CopyButton } from '@/components/ui/copy-button';
import { cn } from '@/lib/utils';

/**
 * A labelled value shown in full — a secret shown once, an ID for support —
 * so it can be selected by hand, with the shared copy button beside it.
 */
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
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex min-w-0 items-start gap-2">
        <code className="min-w-0 flex-1 rounded-md border border-border bg-black/30 px-3 py-2 font-mono text-[0.8rem] break-all text-foreground">
          {display ?? value}
        </code>
        <CopyButton
          value={value}
          label={`Copy ${label.charAt(0).toLowerCase()}${label.slice(1)}`}
        />
      </div>
    </div>
  );
}
