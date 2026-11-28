import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/class-names';

const layouts = cva('flex', {
  variants: {
    layout: {
      inline: 'w-fit flex-wrap items-center gap-x-4 gap-y-1',
      list: 'flex-col items-stretch gap-1',
    },
  },
  defaultVariants: { layout: 'inline' },
});

/** A labelled set of settings as real radio buttons. */
export function RadioChoice<Value extends string>({
  label,
  value,
  options,
  disabled = false,
  layout,
  className,
  onChange,
}: Readonly<{
  label: string;
  value: Value;
  options: readonly Readonly<{
    value: Value;
    label: string;
    description?: string;
  }>[];
  disabled?: boolean;
  className?: string;
  onChange: (value: Value) => void;
}> &
  VariantProps<typeof layouts>) {
  return (
    <RadioGroup
      aria-label={label}
      value={value}
      disabled={disabled}
      className={cn(layouts({ layout }), className)}
      onValueChange={(next) => {
        onChange(next);
      }}
    >
      {options.map((option) => (
        <Radio.Root
          key={option.value}
          value={option.value}
          className="group inline-flex min-h-7 items-center gap-2 rounded-sm text-label text-muted-foreground outline-none hover:text-foreground focus-ring disabled:opacity-45 data-checked:text-foreground pointer-coarse:min-h-10"
        >
          <span
            aria-hidden="true"
            className="grid size-4 shrink-0 place-items-center rounded-full border border-border-strong group-data-checked:border-action"
          >
            <Radio.Indicator className="size-2 rounded-full bg-action" />
          </span>
          <span className="flex min-w-0 flex-col items-start text-left">
            <span>{option.label}</span>
            {option.description === undefined ? null : (
              <span className="text-meta text-subtle-foreground">
                {option.description}
              </span>
            )}
          </span>
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}
