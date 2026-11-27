import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { cn } from '@/lib/class-names';

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
        'flex w-fit flex-wrap items-center gap-x-4 gap-y-1',
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
          className="group inline-flex min-h-7 items-center gap-2 rounded-sm text-label text-muted-foreground outline-none hover:text-foreground focus-ring disabled:opacity-45 data-checked:text-foreground pointer-coarse:min-h-10"
        >
          <span
            aria-hidden="true"
            className="grid size-4 place-items-center rounded-full border border-border-strong group-data-checked:border-action"
          >
            <Radio.Indicator className="size-2 rounded-full bg-action" />
          </span>
          {option.label}
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}
