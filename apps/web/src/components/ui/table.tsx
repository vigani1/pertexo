import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function Table({ className, ...props }: ComponentProps<'table'>) {
  return (
    <div className="w-full">
      <div
        data-slot="table-container"
        className="w-full overflow-x-auto rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        role="region"
        aria-label="Scrollable data table"
        tabIndex={0}
        onKeyDown={(event) => {
          const region = event.currentTarget;
          const step = Math.max(80, Math.floor(region.clientWidth * 0.8));
          if (event.key === 'ArrowRight') {
            event.preventDefault();
            region.scrollLeft += step;
          } else if (event.key === 'ArrowLeft') {
            event.preventDefault();
            region.scrollLeft -= step;
          } else if (event.key === 'Home') {
            event.preventDefault();
            region.scrollLeft = 0;
          } else if (event.key === 'End') {
            event.preventDefault();
            region.scrollLeft = region.scrollWidth;
          }
        }}
      >
        <table
          data-slot="table"
          className={cn('w-full min-w-176 caption-bottom text-sm', className)}
          {...props}
        />
      </div>
    </div>
  );
}

export function TableHeader({ className, ...props }: ComponentProps<'thead'>) {
  return (
    <thead className={cn('border-b border-border', className)} {...props} />
  );
}

export function TableBody({ className, ...props }: ComponentProps<'tbody'>) {
  return (
    <tbody className={cn('[&_tr:last-child]:border-0', className)} {...props} />
  );
}

export function TableRow({ className, ...props }: ComponentProps<'tr'>) {
  return (
    <tr
      className={cn(
        'border-b border-border transition-colors hover:bg-white/[0.03]',
        className,
      )}
      {...props}
    />
  );
}

export function TableHead({ className, ...props }: ComponentProps<'th'>) {
  return (
    <th
      className={cn(
        'h-10 px-3 text-left align-middle font-mono text-[0.68rem] font-medium tracking-[0.08em] text-subtle-foreground uppercase',
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: ComponentProps<'td'>) {
  return (
    <td className={cn('px-3 py-3.5 align-middle', className)} {...props} />
  );
}
