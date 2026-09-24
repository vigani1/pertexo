import { FieldGroup, LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { localUtcOffset } from '../model/run-intent';
import type { RunInput } from '../use-run-input';

/** A run's input (JSON) and optional deadline, validated as one form. */
export function RunInputFields({
  idPrefix,
  inputLabel,
  runInput,
  disabled,
  autoFocus = false,
}: Readonly<{
  idPrefix: string;
  inputLabel: string;
  runInput: RunInput;
  disabled: boolean;
  autoFocus?: boolean;
}>) {
  const { validation } = runInput;
  return (
    <FieldGroup>
      <LabelledField
        id={`${idPrefix}-input`}
        label={inputLabel}
        description="Use {} if the workflow doesn’t read any input."
        error={validation.error('input')}
        thread={validation.thread('input')}
      >
        {(control) => (
          <Textarea
            {...control}
            ref={validation.register('input')}
            name={`${idPrefix}-input`}
            autoComplete="off"
            autoFocus={autoFocus}
            spellCheck={false}
            className="min-h-32 font-mono text-[0.8rem]"
            disabled={disabled}
            value={runInput.input}
            onChange={(event) => {
              runInput.changeInput(event.currentTarget.value);
            }}
            onBlur={runInput.blurInput}
          />
        )}
      </LabelledField>
      <LabelledField
        id={`${idPrefix}-deadline`}
        label="Deadline (optional)"
        description={`In your time zone (${localUtcOffset()}). The run stops if it isn’t finished by then.`}
        error={validation.error('deadline')}
        thread={validation.thread('deadline')}
      >
        {(control) => (
          <Input
            {...control}
            ref={validation.register('deadline')}
            name={`${idPrefix}-deadline`}
            type="datetime-local"
            disabled={disabled}
            value={runInput.deadline}
            onChange={(event) => {
              runInput.changeDeadline(event.currentTarget.value);
            }}
            onBlur={runInput.blurDeadline}
          />
        )}
      </LabelledField>
    </FieldGroup>
  );
}
