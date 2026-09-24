import { cn } from '@/lib/utils';

/** "Pertexo." with the lavender dot. */
export function Wordmark({ className }: Readonly<{ className?: string }>) {
  return (
    <span
      translate="no"
      className={cn(
        'font-heading text-[1.625rem] leading-none font-semibold tracking-[-0.03em]',
        className,
      )}
    >
      Pertexo<span className="text-secondary">.</span>
    </span>
  );
}
