import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
export function TableChoice({
  id,
  value,
  choices,
  onChange,
  disabled = false,
}: Readonly<{
  id: string;
  value: string;
  choices: readonly Readonly<{ value: string; label: string }>[];
  onChange: (value: string) => void;
  disabled?: boolean;
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
      <SelectTrigger id={id}>
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
