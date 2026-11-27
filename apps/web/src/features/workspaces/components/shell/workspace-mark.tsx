import { cn } from '@/lib/class-names';
import { formatInitials } from '@/lib/format/initials';

export function WorkspaceMark({
  name,
  className,
}: Readonly<{ name: string; className?: string }>) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid size-5 shrink-0 place-items-center rounded-xs bg-raised font-sans text-micro font-semibold text-foreground inset-ring inset-ring-border-strong',
        className,
      )}
    >
      {formatInitials(name)}
    </span>
  );
}

export function RingMonogram({
  name,
  className,
}: Readonly<{ name: string; className?: string }>) {
  return (
    // The initials are drawn, not text: the account button around them is
    // named for the person, and its name must hold any visible text it
    // contains (WCAG 2.5.3).
    <span
      aria-hidden="true"
      data-initials={formatInitials(name)}
      className={cn(
        'relative grid size-7.5 shrink-0 place-items-center rounded-full bg-raised text-micro font-semibold text-foreground inset-ring inset-ring-border-strong after:content-[attr(data-initials)]',
        className,
      )}
    />
  );
}
