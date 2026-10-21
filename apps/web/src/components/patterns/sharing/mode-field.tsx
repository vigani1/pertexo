import { useId } from 'react';
import { LabelledField } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
export function SharingModeField({
  label,
  restrictedLabel,
  value,
  disabled,
  onChange,
}: Readonly<{
  label: string;
  restrictedLabel: string;
  value: 'workspace' | 'restricted';
  disabled: boolean;
  onChange: (mode: 'workspace' | 'restricted') => void;
}>) {
  const id = useId();
  const choices = [
    { value: 'workspace', label: 'Workspace members' },
    { value: 'restricted', label: restrictedLabel },
  ];
  return (
    <LabelledField id={id} label={label}>
      {(control) => (
        <Select
          items={choices}
          value={value}
          disabled={disabled}
          onValueChange={(mode) => {
            if (mode === 'workspace' || mode === 'restricted') onChange(mode);
          }}
        >
          <SelectTrigger {...control}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {choices.map((choice) => (
                <SelectItem key={choice.value} value={choice.value}>
                  {choice.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      )}
    </LabelledField>
  );
}
