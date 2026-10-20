import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
export function TableChoice({
  id,
  label,
  value,
  choices,
  onChange,
  disabled = false,
  className,
}: Readonly<{
  id?: string;
  /** Names the control when no visible label sits beside it. */
  label?: string;
  value: string;
  choices: readonly Readonly<{ value: string; label: string }>[];
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}>) {
  return (
    <Select<string>
      value={value}
      items={choices}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
      disabled={disabled}
    >
      <SelectTrigger id={id} aria-label={label} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {choices.map((choice) => (
          <SelectItem key={choice.value} value={choice.value}>
            {choice.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
