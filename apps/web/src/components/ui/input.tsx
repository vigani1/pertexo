import { SearchIcon } from 'lucide-react';
import { Input as InputPrimitive } from '@base-ui/react/input';
import { cn } from '@/lib/class-names';

export function Input({ className, ...props }: InputPrimitive.Props) {
  return (
    <InputPrimitive
      data-slot="input"
      className={cn(
        'recessed-control h-9.5 max-sm:min-h-[var(--control-min-size,2.75rem)] w-full pointer-coarse:h-10 min-w-0 rounded-md border px-3 py-2 text-base sm:text-sm file:mr-3 file:border-0 file:bg-transparent file:font-medium file:text-foreground',
        className,
      )}
      {...props}
    />
  );
}

export function SearchInput({
  className,
  ...props
}: Omit<InputPrimitive.Props, 'type'>) {
  return (
    <div data-slot="search-input" className={cn('relative min-w-0', className)}>
      <SearchIcon
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-3 z-1 size-4 -translate-y-1/2 text-subtle-foreground"
      />
      <Input type="search" className="pl-9" {...props} />
    </div>
  );
}
