import { cn } from '@/lib/utils';

/** The notice's own link: its whole row opens it; bold while unread. */
export function noticeLinkClass({
  unread,
}: Readonly<{ unread: boolean }>): string {
  return cn(
    "min-w-0 truncate outline-none after:absolute after:inset-0 after:rounded-lg after:content-[''] hover:text-accent-foreground focus-visible:after:ring-2 focus-visible:after:ring-ring/60",
    unread
      ? 'font-semibold text-foreground'
      : 'font-medium text-muted-foreground',
  );
}
