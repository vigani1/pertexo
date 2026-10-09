import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export type Choice = Readonly<{ value: string | null; label: string }>;

/** The inspector's single-choice control on the Base UI select. */
export function ChoiceSelect({
  id,
  value,
  choices,
  disabled,
  invalid,
  describedBy,
  onChange,
}: Readonly<{
  id: string;
  value: string | null;
  choices: readonly Choice[];
  disabled: boolean;
  invalid?: boolean;
  describedBy?: string;
  onChange: (value: string | null) => void;
}>) {
  return (
    <Select<string | null>
      items={choices}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        onChange(next);
      }}
    >
      <SelectTrigger
        id={id}
        aria-invalid={invalid === true ? true : undefined}
        aria-describedby={describedBy}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {choices.map((choice) => (
            <SelectItem key={choice.value ?? '\u0000none'} value={choice.value}>
              {choice.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
