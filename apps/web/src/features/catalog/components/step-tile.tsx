import { cva } from 'class-variance-authority';
import { cn } from '@/lib/class-names';
import type { StepPresentation } from '../model/steps/registry';

const tileVariants = cva(
  'grid shrink-0 place-items-center bg-select-raised text-muted-foreground inset-ring inset-ring-border',
  {
    variants: {
      size: {
        sm: 'size-6.5 rounded-sm [&_svg]:size-3.5',
        md: 'size-7.5 rounded-sm [&_svg]:size-4',
        lg: 'size-9.5 rounded-md [&_svg]:size-5',
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
      className={cn(tileVariants({ size }), className)}
    >
      <Icon />
    </span>
  );
}
