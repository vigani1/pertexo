import { Switch as SwitchPrimitive } from '@base-ui/react/switch';
import { cn } from '@/lib/class-names';

export function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'relative inline-flex h-5 pointer-coarse:before:absolute pointer-coarse:before:top-1/2 pointer-coarse:before:left-1/2 pointer-coarse:before:size-[var(--control-min-size,2.75rem)] pointer-coarse:before:-translate-x-1/2 pointer-coarse:before:-translate-y-1/2 w-8.5 shrink-0 items-center rounded-full border border-border-strong bg-raised hover:bg-select-strong transition-colors outline-none focus-ring data-checked:border-action data-checked:bg-action data-checked:hover:bg-action-hover aria-invalid:border-destructive data-disabled:cursor-not-allowed data-disabled:opacity-50 motion-reduce:transition-none',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-3.5 translate-x-0.5 rounded-full bg-muted-foreground transition-[transform,background-color] ease-unspool data-checked:translate-x-4 data-checked:bg-action-foreground motion-reduce:transition-none"
      />
    </SwitchPrimitive.Root>
  );
}
