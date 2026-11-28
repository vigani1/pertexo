import { BookOpenIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/class-names';

/** A link to a public guide; it opens beside the app, never over unsaved work. */
export function GuideLink({
  href,
  children,
  className,
  size = 'default',
}: Readonly<{
  href: string;
  children: ReactNode;
  className?: string;
  size?: 'default' | 'compact';
}>) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'inline-flex items-center gap-1.5 rounded-sm font-medium text-accent-foreground underline-offset-4 outline-none hover:underline focus-ring',
        size === 'compact' ? 'text-xs' : 'text-sm',
        className,
      )}
    >
      <BookOpenIcon aria-hidden="true" className="size-3.5 shrink-0" />
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
