import { LabelledField } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const choices = [
  { value: 'queue', label: 'Queue' },
  { value: 'skip', label: 'Skip' },
];
export function OverflowPicker({
  value,
  disabled,
  onChange,
}: Readonly<{
  value: 'queue' | 'skip';
  disabled: boolean;
  onChange: (value: 'queue' | 'skip') => void;
}>) {
  return (
    <LabelledField
      id="workflow-concurrency-overflow"
      label="When the limit is reached"
      description="Queue waits in acceptance order. Skip ignores new trigger events; manual starts are refused. Calls and draft tests still queue. Without a limit this choice has no effect."
    >
      {(control) => (
        <Select
          items={choices}
          value={value}
          disabled={disabled}
          onValueChange={(next) => {
            if (next === 'queue' || next === 'skip') onChange(next);
          }}
        >
          <SelectTrigger {...control} className="w-full sm:w-48">
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
      )}
    </LabelledField>
  );
}
