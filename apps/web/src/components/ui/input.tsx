import { Input as InputPrimitive } from '@base-ui/react/input';
import { cn } from '@/lib/utils';

export function Input({ className, ...props }: InputPrimitive.Props) {
  return (
    <InputPrimitive
      data-slot="input"
      className={cn(
        'recessed-control h-9 w-full pointer-coarse:h-10 min-w-0 rounded-md border px-3 py-2 text-base md:text-sm file:mr-3 file:border-0 file:bg-transparent file:font-medium file:text-foreground',
        className,
      )}
      {...props}
    />
  );
}
