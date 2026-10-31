import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { cn } from '@/lib/utils';

/** A small, labelled choice of two or three settings, as real radio buttons. */
export function RadioChoice<Value extends string>({
  label,
  value,
  options,
  disabled = false,
  className,
  onChange,
}: Readonly<{
  label: string;
  value: Value;
  options: readonly Readonly<{ value: Value; label: string }>[];
  disabled?: boolean;
  className?: string;
  onChange: (value: Value) => void;
}>) {
  return (
    <RadioGroup
      aria-label={label}
      value={value}
      disabled={disabled}
      className={cn(
        'inline-flex w-fit items-center gap-0.5 rounded-md border border-surface-ink/7 bg-surface-ink/[0.035] p-[3px]',
        className,
      )}
      onValueChange={(next) => {
        onChange(next);
      }}
    >
      {options.map((option) => (
        <Radio.Root
          key={option.value}
          value={option.value}
          className="inline-flex h-7 items-center rounded-sm px-3 text-[0.8rem] font-medium whitespace-nowrap text-subtle-foreground transition-colors outline-none hover:text-foreground focus-ring disabled:pointer-events-none disabled:opacity-50 data-checked:bg-surface-ink/8 data-checked:text-foreground max-sm:min-h-[var(--control-min-size,2.75rem)]"
        >
          {option.label}
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}
