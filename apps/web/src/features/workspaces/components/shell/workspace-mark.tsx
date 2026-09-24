import { cn } from '@/lib/utils';
import { formatInitials, stableIndex } from '@/lib/format-initials';

// Each workspace gets a stable two-colour monogram derived from its name, so
// people can recognise it in the switcher, picker and breadcrumb.
const MARK_GRADIENTS = [
  'from-primary to-secondary',
  'from-secondary to-success',
  'from-success to-primary',
  'from-accent-foreground to-secondary',
  'from-warning to-secondary',
] as const;

export function WorkspaceMark({
  name,
  className,
}: Readonly<{ name: string; className?: string }>) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid size-5 shrink-0 place-items-center rounded-[0.35rem] bg-linear-135 font-heading text-[0.6rem] font-bold text-primary-foreground',
        MARK_GRADIENTS[stableIndex(name, MARK_GRADIENTS.length)],
        className,
      )}
    >
      {formatInitials(name)}
    </span>
  );
}

/** A person's initials inside a thread ring coloured by their name. */
export function PersonAvatar({
  name,
  className,
}: Readonly<{ name: string; className?: string }>) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative grid size-8 shrink-0 place-items-center rounded-full bg-card font-heading text-[0.7rem] font-bold text-foreground',
        'before:absolute before:-inset-0.5 before:rounded-full before:bg-conic before:[mask:radial-gradient(circle,transparent_calc(50%-2px),black_calc(50%-1.5px))]',
        MARK_GRADIENTS[stableIndex(name, MARK_GRADIENTS.length)],
        className,
      )}
    >
      {formatInitials(name)}
    </span>
  );
}
