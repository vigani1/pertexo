import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/class-names';
import { formatInitials } from '@/lib/format/initials';

const workspaceMark = cva(
  'grid shrink-0 place-items-center bg-raised font-sans font-semibold text-foreground inset-ring inset-ring-border-strong',
  {
    variants: {
      size: {
        compact: 'size-5 rounded-xs text-micro',
        list: 'size-9 rounded-lg text-caption',
        picker: 'size-10 rounded-lg text-micro',
        invitation: 'size-12 rounded-full text-base',
        preview:
          'size-14 rounded-xl text-lg transition-[box-shadow] duration-200 motion-reduce:transition-none',
      },
      editing: { true: 'shadow-selection' },
    },
    defaultVariants: { size: 'compact' },
  },
);

export function WorkspaceMark({
  name,
  size,
  editing,
}: Readonly<{ name: string }> & VariantProps<typeof workspaceMark>) {
  return (
    <span aria-hidden="true" className={workspaceMark({ size, editing })}>
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
