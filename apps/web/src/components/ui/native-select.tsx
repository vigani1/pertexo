import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/class-names';

export function NativeSelect({
  className,
  icon,
  ...props
}: ComponentProps<'select'> & Readonly<{ icon?: ReactNode }>) {
  return (
    <div className={cn('relative min-w-0', className)}>
      {icon === undefined ? null : (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground [&_svg]:size-4"
        >
          {icon}
        </span>
      )}
      <select
        className={cn(
          'recessed-control h-9 w-full rounded-md border px-3 text-base outline-offset-2 pointer-coarse:min-h-10 focus-visible:outline-2 focus-visible:outline-ring md:text-sm',
          icon !== undefined && 'pl-9',
        )}
        {...props}
      />
    </div>
  );
}
