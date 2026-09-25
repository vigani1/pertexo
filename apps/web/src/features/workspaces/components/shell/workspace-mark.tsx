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

// The same pairs for a thread ring: the conic gradient is drawn on the
// ring's ::before, so its colour stops must be set there too (Tailwind's
// gradient variables don't inherit into pseudo-elements).
const RING_GRADIENTS = [
  'before:from-primary before:via-secondary before:to-primary',
  'before:from-secondary before:via-success before:to-secondary',
  'before:from-success before:via-primary before:to-success',
  'before:from-accent-foreground before:via-secondary before:to-accent-foreground',
  'before:from-warning before:via-secondary before:to-warning',
] as const;

/**
 * Initials inside a thread ring coloured by the name: people in Team and the
 * account menu, and workspaces in the picker.
 */
export function RingMonogram({
  name,
  className,
}: Readonly<{ name: string; className?: string }>) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative grid size-8 shrink-0 place-items-center rounded-full bg-card font-heading text-[0.7rem] font-bold text-foreground',
        'before:absolute before:-inset-0.5 before:rounded-full before:bg-conic before:[mask:radial-gradient(closest-side,transparent_calc(100%-2px),black_calc(100%-1.5px))]',
        RING_GRADIENTS[stableIndex(name, RING_GRADIENTS.length)],
        className,
      )}
    >
      {formatInitials(name)}
    </span>
  );
}
