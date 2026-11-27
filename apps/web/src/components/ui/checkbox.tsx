import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox';
import { CheckIcon } from 'lucide-react';
import { cn } from '@/lib/class-names';

export function Checkbox({
  className,
  ...props
}: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'recessed-control relative flex size-4 pointer-coarse:before:absolute pointer-coarse:before:top-1/2 pointer-coarse:before:left-1/2 pointer-coarse:before:size-[var(--control-min-size,2.75rem)] pointer-coarse:before:-translate-x-1/2 pointer-coarse:before:-translate-y-1/2 shrink-0 items-center justify-center rounded-xs border border-border-strong data-checked:border-action data-checked:bg-action data-checked:text-action-foreground data-disabled:cursor-not-allowed data-disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-items-center"
      >
        <CheckIcon className="size-3.5" strokeWidth={1.7} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
