import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Ref } from 'react';

export type Choice = Readonly<{ value: string | null; label: string }>;

/** The inspector's single-choice control on the Base UI select. */
export function ChoiceSelect({
  value,
  choices,
  disabled,
  onChange,
  control,
}: Readonly<{
  value: string | null;
  choices: readonly Choice[];
  disabled: boolean;
  onChange: (value: string | null) => void;
  control: Readonly<{
    id: string;
    invalid?: boolean;
    describedBy?: string | undefined;
    /** For a select that shares its field label with another control. */
    label?: string;
    ref?: Ref<HTMLButtonElement> | undefined;
    name?: string;
  }>;
}>) {
  const { id, invalid, describedBy, label, ref, name } = control;

  return (
    <Select<string | null>
      items={choices}
      name={name}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        onChange(next);
      }}
    >
      <SelectTrigger
        id={id}
        ref={ref}
        aria-invalid={(invalid ?? false) ? true : undefined}
        aria-describedby={describedBy}
        aria-label={label}
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
