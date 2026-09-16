import { Input as InputPrimitive } from '@base-ui/react/input';
import { cn } from '@/lib/utils';

export function Input({ className, ...props }: InputPrimitive.Props) {
  return (
    <InputPrimitive
      data-slot="input"
      className={cn(
        'recessed-control h-10 w-full min-w-0 rounded-lg border px-3 py-2 text-base md:text-sm file:mr-3 file:border-0 file:bg-transparent file:font-medium file:text-foreground',
        className,
      )}
      {...props}
    />
  );
}
