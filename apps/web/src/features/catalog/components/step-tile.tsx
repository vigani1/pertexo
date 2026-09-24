import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import type { StepPresentation } from '../step-presentation';

// Family colours: trigger cyan, action ice, logic lavender, transform mint,
// output neutral. The tile is decorative; the step name carries meaning.
const tileVariants = cva(
  'grid shrink-0 place-items-center shadow-[inset_0_0_0_1px_var(--tile-ring)]',
  {
    variants: {
      family: {
        trigger:
          'bg-primary/10 text-primary [--tile-ring:color-mix(in_srgb,var(--primary)_25%,transparent)]',
        action:
          'bg-accent-foreground/7 text-accent-foreground [--tile-ring:color-mix(in_srgb,var(--accent-foreground)_18%,transparent)]',
        logic:
          'bg-secondary/9 text-secondary [--tile-ring:color-mix(in_srgb,var(--secondary)_24%,transparent)]',
        transform:
          'bg-success/8 text-success [--tile-ring:color-mix(in_srgb,var(--success)_22%,transparent)]',
        output:
          'bg-white/5 text-muted-foreground [--tile-ring:var(--border-strong)]',
        unknown:
          'bg-white/4 text-subtle-foreground [--tile-ring:var(--border)]',
      },
      size: {
        sm: 'size-6.5 rounded-[0.5rem] [&_svg]:size-3.5',
        md: 'size-7.5 rounded-[0.5625rem] [&_svg]:size-4',
        lg: 'size-9.5 rounded-[0.6875rem] [&_svg]:size-5',
      },
    },
    defaultVariants: { size: 'md' },
  },
);

export function StepTile({
  step,
  size,
  className,
}: Readonly<{
  step: Pick<StepPresentation, 'family' | 'icon'>;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}>) {
  const Icon = step.icon;
  return (
    <span
      aria-hidden="true"
      data-family={step.family}
      className={cn(tileVariants({ family: step.family, size }), className)}
    >
      <Icon />
    </span>
  );
}
