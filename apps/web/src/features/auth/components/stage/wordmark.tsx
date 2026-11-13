import { cn } from '@/lib/class-names';

/** "Pertexo." with the lavender dot. */
export function Wordmark({ className }: Readonly<{ className?: string }>) {
  return (
    <span
      translate="no"
      className={cn(
        'font-display text-wordmark-lg leading-none [--display-optical-size:26] [--display-width:80%]',
        className,
      )}
    >
      Pertexo<span className="text-secondary">.</span>
    </span>
  );
}
