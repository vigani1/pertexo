import { Switch as SwitchPrimitive } from '@base-ui/react/switch';
import { cn } from '@/lib/utils';

export function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-white/12 bg-white/8 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60 data-checked:border-success/60 data-checked:bg-success/25 data-disabled:cursor-not-allowed data-disabled:opacity-50 motion-reduce:transition-none',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-3.5 translate-x-0.5 rounded-full bg-muted-foreground transition-[transform,background-color] ease-unspool data-checked:translate-x-[1.1rem] data-checked:bg-success data-checked:shadow-[0_0_8px_var(--success)] motion-reduce:transition-none"
      />
    </SwitchPrimitive.Root>
  );
}
