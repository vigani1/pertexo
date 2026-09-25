import { DeadlineField } from '@/components/ui/deadline-field';
import { FieldGroup, LabelledField } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
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
      <DeadlineField
        value={runInput.deadline}
        error={validation.error('deadline')}
        thread={validation.thread('deadline')}
        disabled={disabled}
        register={validation.register('deadline')}
        onChange={runInput.changeDeadline}
        onBlur={runInput.blurDeadline}
      />
    </FieldGroup>
  );
}
